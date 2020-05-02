import config from 'config';
import Router from 'koa-router';
import { DefaultState, Context } from 'koa';
import { redis } from '../lib/redis';
// import cors from '@koa/cors';

const router = new Router<DefaultState, Context>();

// const allowedOrigins = ['https://twitch.com'];
// router.use(cors({
//   origin: (ctx) => {
//     if (allowedOrigins.includes(ctx.origin)) {
//       return ctx.origin;
//     }
//     return null;
//   }
// }))

router.post(`/api/conversations/:id/messages`, async (ctx) => {
  const message = ctx.request.body as string;
  ctx.assert(typeof message === 'string', 400, 'body should be a string');
  const conversationId = ctx.params.id;
  ctx.assert(typeof conversationId === 'string', 400, 'id sould be a string');
  ctx.assert(message.length < 1024, 400, 'body should be less than 1024 chars');
  ctx.assert(conversationId < 64, 400, 'conversion_id should be less than 64 chars');

  await redis.pipeline()
    .lpush(`conversation:${conversationId}`, message)
    .expire(`conversation:${conversationId}`, config.get('conversationExpireTime'))
    .exec();

  ctx.status = 204;
});

router.get('/api/conversations/:id/messages', async (ctx) => {
  const conversationId = ctx.params.id;
  ctx.assert(conversationId < 64, 400, 'conversion_id should be less than 64 chars');

  const [messages] = await redis.pipeline()
    .lrange(`conversation:${conversationId}`, 0, -1)
    .del(`conversation:${conversationId}`)
    .exec();

  ctx.body = messages;
});

export default router;
