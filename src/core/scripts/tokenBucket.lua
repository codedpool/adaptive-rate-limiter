-- Atomic token-bucket rate limit: refill + check + consume in ONE round trip.
-- Clock source is Redis server TIME, so skewed app-node clocks can never
-- corrupt the bucket (every node sees the same authoritative clock).
--
-- KEYS[1] = bucket key (a hash: { tokens, ts })
-- ARGV[1] = capacity     (max tokens; the burst ceiling)
-- ARGV[2] = refillPerMs  (tokens added per millisecond = sustained rate)
-- ARGV[3] = cost         (tokens this request consumes)
-- ARGV[4] = ttlMs        (idle expiry so abandoned buckets self-clean)
--
-- Returns { allowed(1|0), remaining, retryAfterMs, resetMs }

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local ttlMs = tonumber(ARGV[4])

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  ts = now
end

local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + elapsed * refillPerMs)

local allowed = 0
if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, ttlMs)

local retryAfterMs = 0
if allowed == 0 and refillPerMs > 0 then
  retryAfterMs = math.ceil((cost - tokens) / refillPerMs)
end

local resetMs = 0
if refillPerMs > 0 then
  resetMs = math.ceil((capacity - tokens) / refillPerMs)
end

return { allowed, math.floor(tokens), retryAfterMs, resetMs }
