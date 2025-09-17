// services/price-cache.js
// 간단한 인메모리 가격 캐시 (마켓 → price, ts)
const _prices = Object.create(null);

module.exports = {
  set(symbol, price) {
    if (typeof price === 'number' && isFinite(price)) {
      _prices[symbol] = { price, ts: Date.now() };
    }
  },
  setMany(entries) {
    for (const [sym, px] of Object.entries(entries || {})) {
      this.set(sym, Number(px));
    }
  },
  get(symbol) {
    const row = _prices[symbol];
    return row ? row.price : null;
  },
  snapshot() {
    return JSON.parse(JSON.stringify(_prices));
  }
};
