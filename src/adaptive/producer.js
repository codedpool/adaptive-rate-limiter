/**
 * Emits request-decision events to a capped Redis Stream. This is the ONLY thing
 * the request hot path does for the adaptive layer, and it is deliberately
 * fire-and-forget: we never await it and never let a stream error affect the
 * request. The model lives entirely on the consuming side (the worker).
 */
export class StreamProducer {
  /**
   * @param {import('ioredis').Redis} client
   * @param {object} opts
   * @param {string} opts.streamKey
   * @param {number} [opts.maxLen]  approximate cap (XADD MAXLEN ~) so the stream self-trims
   */
  constructor(client, { streamKey, maxLen = 100_000 }) {
    this.client = client;
    this.streamKey = streamKey;
    this.maxLen = maxLen;
  }

  /** @param {{key:string, allowed:boolean, route?:string, ts:number}} event */
  emit(event) {
    // MAXLEN ~ lets Redis trim in efficient batches rather than on every add.
    this.client
      .xadd(
        this.streamKey,
        'MAXLEN',
        '~',
        this.maxLen,
        '*',
        'key',
        event.key,
        'allowed',
        event.allowed ? '1' : '0',
        'route',
        event.route || '',
        'ts',
        String(event.ts),
      )
      .catch(() => {}); // swallow: the hot path must never be affected
  }
}
