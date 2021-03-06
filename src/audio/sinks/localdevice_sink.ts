import { Worker } from 'worker_threads';
import { AudioServer, AudioStream } from 'audioworklet';

import { resolve } from 'path';
import debug from 'debug';
import { now } from '../../utils/misc';
import { AudioChunkStreamOutput } from '../../utils/audio/chunk_stream';
import { AudioSink } from './audio_sink';
import { AudioSource } from '../sources/audio_source';
import {
  OPUS_ENCODER_RATE, OPUS_ENCODER_CHUNK_SAMPLES_COUNT, MAX_LATENCY,
} from '../../utils/constants';
import { LocalDeviceSinkDescriptor } from './sink_type';
import { getOutputDeviceFromId, getAudioServer } from '../../utils/audio/localAudioDevice';
import { AudioSourcesSinksManager } from '../audio_sources_sinks_manager';
import { AudioInstance } from '../utils';
import { CircularTypedArray } from '../../utils/circularTypedArray';

export class LocalDeviceSink extends AudioSink {
  type: 'localdevice' = 'localdevice';
  local: true = true;
  deviceId: string;
  buffer: CircularTypedArray<Float32Array>;
  delayFromLocalNowBuffer = new Float64Array(new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT));

  private worklet: Worker;
  private cleanStream;
  private audioStream: AudioStream;

  constructor(descriptor: LocalDeviceSinkDescriptor, manager: AudioSourcesSinksManager) {
    super(descriptor, manager);
    this.deviceId = descriptor.deviceId;
    this.available = false; // device is considered not available at first before this.updateAvailability
    this.updateAvailability();
    setInterval(this.updateAvailability, 5000);
  }

  isDeviceAvailable = async () => !!(await getOutputDeviceFromId(this.deviceId))
  private updateAvailability = async () => {
    this.updateInfo({ available: await this.isDeviceAvailable() });
  }

  async _startSink(source: AudioSource) {
    this.log(`Creating speaker`);
    await source.peer.waitForFirstTimeSync();
    const device = getOutputDeviceFromId(this.deviceId);
    this.audioStream = getAudioServer().initOutputStream(this.deviceId, {
      sampleRate: OPUS_ENCODER_RATE,
      name: source.name,
      format: AudioServer.F32LE,
      channels: this.channels,
    });
    this.worklet = this.audioStream.attachProcessFunctionFromWorker(resolve(__dirname, './audioworklets/node_audioworklet.js'));
    this.audioStream.start();

    const bufferSize = MAX_LATENCY * (OPUS_ENCODER_RATE / 1000) * this.channels * Float32Array.BYTES_PER_ELEMENT;
    const bufferData = new SharedArrayBuffer(bufferSize);
    this.buffer = new CircularTypedArray(Float32Array, bufferData);
    this.updateInfo({ latency: device.minLatency });
    this.setDelayFromLocalNow();
    this.worklet.postMessage({
      type: 'buffer',
      buffer: bufferData,
      delayFromLocalNowBuffer: this.delayFromLocalNowBuffer.buffer,
      channels: this.channels,
      debug: debug.enabled('soundsync:audioSinkDebug'),
    });

    const handleTimedeltaUpdate = () => {
      this.log(`Resynchronizing sink after update from timedelta with peer or source latency`);
      this.setDelayFromLocalNow();
    };
    this.pipedSource.peer.on('timedeltaUpdated', handleTimedeltaUpdate);
    // this is needed to resync the audioworklet when the source latency is updated
    this.pipedSource.on('update', handleTimedeltaUpdate);
    const syncDeviceVolume = () => {
      this.audioStream.setVolume(this.volume);
    };
    const latencySyncInterval = setInterval(this.setDelayFromLocalNow, 1000);
    this.cleanStream = () => {
      if (this.pipedSource.peer) {
        this.pipedSource.peer.off('timedeltaUpdated', handleTimedeltaUpdate);
      }
      if (this.pipedSource) {
        this.pipedSource.off('update', handleTimedeltaUpdate);
      }
      this.off('update', syncDeviceVolume);
      this.audioStream.stop();
      clearInterval(latencySyncInterval);
      delete this.audioStream;
      delete this.audioStream;
    };
  }

  _stopSink() {
    if (this.cleanStream) {
      this.cleanStream();
      delete this.cleanStream;
    }
  }

  handleAudioChunk = (data: AudioChunkStreamOutput) => {
    if (!this.worklet) {
      return;
    }
    if (!this.pipedSource || !this.pipedSource.peer) {
      this.log(`Received a chunk for a not piped sink, ignoring`);
      return;
    }
    const chunk = new Float32Array(data.chunk.buffer, data.chunk.byteOffset, data.chunk.byteLength / Float32Array.BYTES_PER_ELEMENT);
    const offset = data.i * OPUS_ENCODER_CHUNK_SAMPLES_COUNT * this.channels;
    this.buffer.set(chunk, offset);
  }

  setDelayFromLocalNow = () => {
    // we are not using this.latency here because this is directly handled by the audio worklet and makes it much more precise
    // the audioworklet handles the synchronization between the audio device clock and the system clock
    // this method is here to handle the synchronization between the system clock and the remote peer clock
    this.delayFromLocalNowBuffer[0] = this.pipedSource.peer.getCurrentTime(true)
      - this.pipedSource.startedAt
      - this.pipedSource.latency
      - now();
  }

  toDescriptor = (sanitizeForConfigSave = false): AudioInstance<LocalDeviceSinkDescriptor> => ({
    type: this.type,
    name: this.name,
    uuid: this.uuid,
    deviceId: this.deviceId,
    pipedFrom: this.pipedFrom,
    volume: this.volume,
    ...(!sanitizeForConfigSave && {
      peerUuid: this.peerUuid,
      instanceUuid: this.instanceUuid,
      latency: this.latency,
      available: this.available,
      error: this.error,
    }),
  })
}
