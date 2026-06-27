-- Atomic HYBRID limiter: token bucket (short-term burst smoothing) AND an exact
-- sliding-window log (hard ceiling per window). A request is allowed only if
-- BOTH allow it, and tokens/entries are committed only on success — so the two
-- halves can never drift out of sync. One round trip; clock = Redis server TIME.
--
-- KEYS[1] = token bucket key (hash)
-- KEYS[2] = sliding window key (sorted set)
-- ARGV[1] = capacity     (burst ceiling)
-- ARGV[2] = refillPerMs  (sustained rate)
-- ARGV[3] = limit        (window ceiling)
-- ARGV[4] = windowMs
-- ARGV[5] = cost
-- ARGV[6] = ttlMs        (token bucket idle expiry)
-- ARGV[7] = id           (unique per call)
--
-- Returns { allowed(1|0), remaining, retryAfterMs, resetMs }  (remaining = min of both)

local tbKey = KEYS[1]
local swKey = KEYS[2]
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local windowMs = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])
local ttlMs = tonumber(ARGV[6])
local id = ARGV[7]

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

-- ---- token bucket: evaluate, do not commit yet ----
local bucket = redis.call('HMGET', tbKey, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts = tonumber(bucket[2])
if tokens == nil then
  tokens = capacity
  ts = now
end
local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + elapsed * refillPerMs)
local tbAllowed = tokens >= cost

-- ---- sliding window: evaluate, do not commit yet ----
local windowStart = now - windowMs
redis.call('ZREMRANGEBYSCORE', swKey, 0, windowStart)
local count = redis.call('ZCARD', swKey)
local swAllowed = (count + cost) <= limit

-- ---- commit only if both pass ----
local allowed = 0
if tbAllowed and swAllowed then
  allowed = 1
  tokens = tokens - cost
  for i = 1, cost do
    redis.call('ZADD', swKey, now, id .. ':' .. i)
  end
  count = count + cost
end

-- Persist refilled bucket state regardless (refill must not be lost on denial).
redis.call('HSET', tbKey, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', tbKey, ttlMs)
redis.call('PEXPIRE', swKey, windowMs)

local tbRemaining = math.floor(tokens)
local swRemaining = limit - count
if swRemaining < 0 then swRemaining = 0 end
local remaining = math.min(tbRemaining, swRemaining)

local retryAfterMs = 0
local resetMs = windowMs
if allowed == 0 then
  if not tbAllowed and refillPerMs > 0 then
    retryAfterMs = math.ceil((cost - tokens) / refillPerMs)
  end
  if not swAllowed then
    local oldest = redis.call('ZRANGE', swKey, 0, 0, 'WITHSCORES')
    if oldest[2] ~= nil and oldest[2] ~= false then
      local swRetry = (tonumber(oldest[2]) + windowMs) - now
      if swRetry > retryAfterMs then retryAfterMs = swRetry end
    end
  end
  if retryAfterMs < 0 then retryAfterMs = 0 end
end

return { allowed, remaining, retryAfterMs, resetMs }
