// ============================================================================
// server/ratelimit.js — token-bucket rate limiter (one per connection).
//
// A bucket holds up to `capacity` tokens and refills at `perSec` tokens/second.
// `take()` consumes one token and reports whether the caller is within budget; an
// over-budget caller gets false and its message is dropped. This is the flood
// guard index.js arms on every socket, so a burst of intents dies before it can
// fan out into a broadcast to every device in the room.
//
// The clock is injectable so the refill maths can be tested deterministically.
// ============================================================================

export class TokenBucket {
  constructor(capacity, perSec, now = Date.now) {
    this.capacity = capacity;
    this.perSec = perSec;
    this.now = now;
    this.tokens = capacity; // start full: a fresh connection gets its whole burst
    this.last = now();
  }

  take() {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.perSec);
    this.last = t;
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
}
