// utils.js - 코인별 호가 단위 적용
import { PRICE_STEPS, COIN_PRICE_STEPS } from "./constants.js";

export class Utils {
  static formatKRW(amount) {
    return Math.floor(Number(amount) || 0).toLocaleString("ko-KR");
  }

  static formatCoinAmount(amount, decimals = 8) {
    return Number(amount || 0).toFixed(decimals);
  }

  static formatPercent(rate) {
    return (Number(rate || 0) * 100).toFixed(2);
  }

  static parseNumber(value) {
    return Number(String(value).replace(/,/g, "")) || 0;
  }

  // 🔧 코인별 호가 단위 계산
  static getPriceStep(price, market = null) {
    // 특정 코인의 호가 단위가 있으면 사용, 없으면 기본값 사용
    const steps =
      market && COIN_PRICE_STEPS[market]
        ? COIN_PRICE_STEPS[market]
        : PRICE_STEPS;

    for (const { min, step } of steps) {
      if (price >= min) return step;
    }
    return market === "KRW-XRP" ? 1 : 1000; // 리플은 1원, 나머지는 1000원 기본
  }

  // 🔧 코인별 가격 단위로 조정
  static adjustPriceToStep(price, market = null) {
    const step = this.getPriceStep(price, market);
    return Math.round(price / step) * step;
  }

  // 🔧 현재가 대비 % 계산 시 호가 단위 적용
  static calculatePriceWithPercentage(basePrice, percentage, market = null) {
    const newPrice = basePrice * (1 + percentage / 100);
    return this.adjustPriceToStep(newPrice, market);
  }

  static calculateTotal(price, quantity) {
    const total = this.parseNumber(price) * this.parseNumber(quantity);
    return Math.floor(total);
  }

  // 🔧 총액에서 수량 역계산 (1000원 단위 고려)
  static calculateQuantityFromTotal(total, price, market = null) {
    const parsedTotal = this.parseNumber(total);
    const parsedPrice = this.parseNumber(price);

    if (parsedPrice <= 0) return 0;

    let adjustedTotal = parsedTotal;

    // 🔧 비트코인/이더리움의 경우 총액을 1000원 단위로 조정
    if (market === "KRW-BTC" || market === "KRW-ETH") {
      adjustedTotal = Math.floor(parsedTotal / 1000) * 1000;
    }

    return adjustedTotal / parsedPrice;
  }

  // 🔧 코인별 총액 단위 조정
  static adjustTotalToStep(total, market = null) {
    const parsedTotal = this.parseNumber(total);

    // 비트코인/이더리움은 1000원 단위로 조정
    if (market === "KRW-BTC" || market === "KRW-ETH") {
      return Math.floor(parsedTotal / 1000) * 1000;
    }

    // 리플은 그대로
    return Math.floor(parsedTotal);
  }

  // 🔧 코인별 최소 주문 단위 확인
  static validateOrderAmount(total, market) {
    const minAmount = market === "KRW-XRP" ? 5000 : 5000; // 모든 코인 5000원 최소
    return total >= minAmount;
  }

  static formatDateTime(dateString) {
    const date = new Date(dateString);
    return date.toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
}
