import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

import _ from 'lodash';
import debug, { Debugger } from 'debug';
import { NO_RESPONSE_TIMEOUT } from '../utils/constants';
import { BUILD_VERSION } from '../utils/version';
import { handleSharedStateFromPeer } from '../coordinator/shared_state';
import {
  RPCType, RPCRequestBody, RPCResponseBody, rpcHandlers,
} from './rpc/rpc';
import { getLocalPeer } from './local_peer';
import { getPeersManager } from './get_peers_manager';
import {
  ControllerMessage,
  ControllerMessageHandler,
  RPCMessage,
} from './messages';
import { now } from '../utils/misc';
import { BasicNumericStatsTracker } from '../utils/basicNumericStatsTracker';

const TIME_DELTAS_TO_KEEP = 100;
// if there is less than this diff between the newly computed time delta and the saved time delta, update it and emit a event
// this is used to not reupdate the sound sinks for every small difference in the timedelta but only if there is too much diff
const MS_DIFF_TO_UPDATE_TIME_DELTA = 5;
// we use multiple time requests when starting the connection to prevent having a incorrect value from a network problem at this specific moment
const TIMESYNC_INIT_REQUEST_COUNT = 10;
const TIMEKEEPER_REFRESH_INTERVAL = 100;

export enum Capacity {
  Librespot = 'librespot',
  Shairport = 'shairport',
  HttpServerAccessible = 'http_server_accessible',
  Hue = 'hue',
  ChromecastInteraction = 'chromecast_interaction',
  SharedStateKeeper = 'shared_state_keeper', // a keeper can be trusted with not changing network of peer and can be considered a source of truth, this is useful to prevent the webui to leak state to another set of peer in another network
  AirplaySink = 'airplay_sink',
}

export abstract class Peer extends EventEmitter {
  uuid: string;
  instanceUuid: string;
  name: string;
  version: string;
  state: 'connecting' | 'connected' | 'deleted' = 'connecting';
  timeDelta = 0;
  private timedeltas = new BasicNumericStatsTracker(TIME_DELTAS_TO_KEEP);
  log: Debugger;
  protected logPerMessageType: {[type: string]: Debugger} = {}; // we use this to prevent having to create a debug() instance on each message receive which cause a memory leak
  private rpcResponseHandlers: {[uuid: string]: (message: RPCMessage) => void} = {};
  capacities: Capacity[];
  isLocal: boolean;
  private onRemoteDisconnect: () => any;
  private timekeepInterval: NodeJS.Timeout;
  private missingPeerResponseTimeout: NodeJS.Timeout;

  constructor({
    uuid, name, capacities, instanceUuid, version,
  }: PeerDescriptor, { onRemoteDisconnect = () => {} } = {}) {
    super();
    this.setMaxListeners(1000);
    this.isLocal = false;
    this.name = name;
    this.uuid = uuid;
    this.log = debug(`soundsync:peer:${uuid}`);
    this.instanceUuid = instanceUuid;
    this.capacities = capacities || [];
    this.version = version;
    this.onRemoteDisconnect = onRemoteDisconnect;
    this.log(`Created new peer`);
    this.onControllerMessage(`timekeepRequest`, (message) => {
      this.sendControllerMessage({
        type: 'timekeepResponse',
        sentAt: message.sentAt,
        respondedAt: now(),
      });
    });
    this.onControllerMessage(`timekeepResponse`, (message) => {
      const receivedAt = now();
      const roundtripTime = receivedAt - message.sentAt;
      const receivedByPeerAt = message.sentAt + (roundtripTime / 2);
      const delta = message.respondedAt - receivedByPeerAt;
      this.timedeltas.push(delta);
      if (this.timedeltas.full(TIMESYNC_INIT_REQUEST_COUNT)) {
        // we have enough measures to calculate a precise time delta between peers
        const realTimeDelta = this.timedeltas.median();
        if (Math.abs(realTimeDelta - this.timeDelta) > MS_DIFF_TO_UPDATE_TIME_DELTA) {
          this.log(`Updating timedelta to ${realTimeDelta}, diff was ${(realTimeDelta - this.timeDelta).toFixed(2)}ms`);
          this.timeDelta = realTimeDelta;
          this.emit('timedeltaUpdated');
        }
      }
      this.emit('timesyncStateUpdated');
      // networkLatency = roundtripTime / 2;
    });
    this.timekeepInterval = setInterval(this._sendTimekeepRequest, TIMEKEEPER_REFRESH_INTERVAL);

    this.onControllerMessage('peerInfo', (message) => {
      const existingPeer = getPeersManager().getConnectedPeerByUuid(message.peer.uuid);
      if (existingPeer) {
        if (existingPeer.instanceUuid === message.peer.instanceUuid) { // this is the same peer
          this.destroy('Peer is already connected, this is a duplicate');
          return;
        }
        // this is a new instance of the same peer, disconnect previous instance
        existingPeer.destroy('New instance of peer connected', { advertiseDestroy: true });
      }
      this.instanceUuid = message.peer.instanceUuid;
      this.name = message.peer.name;
      this.capacities = message.peer.capacities;
      this.uuid = message.peer.uuid;
      this.version = message.peer.version;
      if (this.state !== 'connected') {
        this.log = debug(`soundsync:peer:${message.peer.uuid}`);
        this.setState('connected');
        this.log('Connected');
      }
      if (message.sharedState) {
        handleSharedStateFromPeer(message.sharedState);
      }
    });
    this.onControllerMessage('rpc', async (message) => {
      if (message.isResponse) {
        if (this.rpcResponseHandlers[message.uuid]) {
          this.rpcResponseHandlers[message.uuid](message);
        }
        return;
      }
      try {
        const body = await rpcHandlers[message.rpcType](this, message.body);
        this.sendControllerMessage({
          type: 'rpc',
          isResponse: true,
          body,
          uuid: message.uuid,
          rpcType: message.rpcType,
        });
      } catch (e) {
        this.sendControllerMessage({
          type: 'rpc',
          isResponse: true,
          isError: true,
          body: e.toString(),
          uuid: message.uuid,
          rpcType: message.rpcType,
        });
      }
    });
    this.on('stateChange', () => {
      if (this.state !== 'connected') {
        this.timedeltas.flush();
      }
      if (this.state === 'connected') {
        getPeersManager().emit('newConnectedPeer', this);
        if (!this.isLocal) {
          _.times(TIMESYNC_INIT_REQUEST_COUNT, (i) => {
            setTimeout(this._sendTimekeepRequest, i * 10); // 10 ms between each request
          });
        }
      }
    });
    getPeersManager().emit('peerChange', this);
  }

  setState = (state: 'connecting' | 'connected' | 'deleted') => {
    if (this.state === state) {
      return;
    }
    if (this.state === 'deleted') {
      return; // once it's deleted, it's not possible to go back to another state
    }
    this.state = state;
    // setImmediate is necessary to force same async behavior even for peer that are connected at start like local peer
    setImmediate(() => {
      this.emit('stateChange', this);
      getPeersManager().emit('peerChange', this);
      if (state === 'connected') {
        getPeersManager().emit('connectedPeer', this);
      }
    });
  }

  abstract sendControllerMessage(message: ControllerMessage): void;
  // need to be called by class which implement peer when a message is received
  protected _onReceivedMessage = (message) => {
    if (this.missingPeerResponseTimeout) {
      clearTimeout(this.missingPeerResponseTimeout);
    }
    if (!this.isLocal) {
      this.missingPeerResponseTimeout = setTimeout(this.handleNoResponseTimeout, NO_RESPONSE_TIMEOUT);
    }
    if (!this.logPerMessageType[message.type]) {
      this.logPerMessageType[message.type] = this.log.extend(message.type);
    }
    this.logPerMessageType[message.type]('Received controller message', message);
    this.emit(`controllerMessage:all`, { peer: this, message });
    this.emit(`controllerMessage:${message.type}`, { peer: this, message });
    getPeersManager().emit(`controllerMessage:${message.type}`, { message, peer: this });
  }

  private handleNoResponseTimeout = () => {
    this.destroy('no messages for a too long, timeout', { advertiseDestroy: true, canTryReconnect: true });
  }

  onControllerMessage: ControllerMessageHandler<this> = (type, handler) => this.on(`controllerMessage:${type}`, ({ message, peer }) => handler(message, peer))

  waitForConnected = async () => {
    if (this.state === 'connected') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const listener = () => {
        if (this.state === 'connected') {
          return;
        }
        this.removeListener('stateChange', listener);
        resolve();
      };
      this.addListener('stateChange', listener);
    });
  }

  waitForFirstTimeSync = async () => {
    if (this.isTimeSynchronized()) {
      return true;
    }
    return new Promise((r) => {
      const timesyncStateUpdatedHandler = () => {
        if (!this.isTimeSynchronized()) {
          this.off('timesyncStateUpdated', timesyncStateUpdatedHandler);
          r();
        }
      };
      this.on('timesyncStateUpdated', timesyncStateUpdatedHandler);
    });
  }

  isTimeSynchronized = () => this === getLocalPeer() || this.timedeltas.full(TIMESYNC_INIT_REQUEST_COUNT)
  getCurrentTime = (realDelta = false) => {
    if (this === getLocalPeer()) {
      return now();
    }
    return now() + (realDelta ? this.timedeltas.median() : this.timeDelta);
  }
  private _sendTimekeepRequest = () => {
    if (this.isLocal) {
      return;
    }
    this.sendControllerMessage({
      type: 'timekeepRequest',
      sentAt: now(),
    });
  }

  destroy = (reason = 'unknown', { advertiseDestroy = false, canTryReconnect = false } = {}) => {
    if (this.state === 'deleted') {
      return;
    }
    if (advertiseDestroy) {
      this.sendControllerMessage({ type: 'disconnect' });
    }
    this.setState('deleted');
    this.log(`Destroying peer, reason: ${reason}`);
    this._destroy();
    getPeersManager().unregisterPeer(this);
    clearInterval(this.timekeepInterval);
    this.removeAllListeners();
    getPeersManager().emit('peerChange');
    if (this.onRemoteDisconnect && canTryReconnect) {
      this.onRemoteDisconnect();
    }
  }

  _destroy = () => undefined;

  toDescriptor = (): PeerDescriptor => ({
    uuid: this.uuid,
    name: this.name,
    instanceUuid: this.instanceUuid,
    capacities: this.capacities,
    version: BUILD_VERSION,
  })

  sendRcp = <T extends RPCType>(type: T, message: RPCRequestBody<T>) => new Promise<RPCResponseBody<T>>((resolve, reject) => {
    const uuid = uuidv4();
    this.rpcResponseHandlers[uuid] = (m) => {
      delete this.rpcResponseHandlers[uuid];
      if (m.isError) {
        reject(new Error(m.body));
      } else {
        resolve(m.body);
      }
    };
    this.sendControllerMessage({
      type: 'rpc',
      rpcType: type,
      isResponse: false,
      body: message,
      uuid,
    });
  })
}

export interface PeerDescriptor {
  uuid: string;
  // the instanceUuid changes between restarts
  instanceUuid: string;
  name: string;
  host?: string;
  capacities?: Capacity[];
  version?: string;
}
