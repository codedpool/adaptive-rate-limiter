-- Atomic EXACT sliding-window-log rate limit using a sorted set of timestamps.
-- One round trip; clock source is Redis server TIME.
--
-- Unlike a fixed window, this has no boundary burst (2x at the edge) problem,
-- and unlike a sliding-window *counter* it is exact rather than approximate.
-- Cost: O(log n) per op and one zset entry per request within the window.
--
-- KEYS[1] = window key (sorted set; score = timestamp, member = unique id)
-- ARGV[1] = limit       (max requests per window)
-- ARGV[2] = windowMs
-- ARGV[3] = cost
-- ARGV[4] = id          (unique per call so members never collide)
--
-- Returns { allowed(1|0), remaining, retryAfterMs, resetMs }

local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local id = ARGV[4]

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local windowStart = now - windowMs

-- Evict entries that have aged out of the window, then count what remains.
redis.call('ZREMRANGEBYSCORE', key, 0, windowStart)
local count = redis.call('ZCARD', key)

local allowed = 0
if count + cost <= limit then
  allowed = 1
  for i = 1, cost do
    redis.call('ZADD', key, now, id .. ':' .. i)
  end
  count = count + cost
end

redis.call('PEXPIRE', key, windowMs)

local remaining = limit - count
if remaining < 0 then remaining = 0 end

-- resetMs / retryAfterMs derive from when the oldest in-window entry expires.
local retryAfterMs = 0
local resetMs = windowMs
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
if oldest[2] ~= nil and oldest[2] ~= false then
  resetMs = (tonumber(oldest[2]) + windowMs) - now
  if resetMs < 0 then resetMs = 0 end
  if allowed == 0 then retryAfterMs = resetMs end
end

return { allowed, remaining, retryAfterMs, resetMs }
