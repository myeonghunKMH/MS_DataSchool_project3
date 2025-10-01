// src/utils/validation-utils.js

const KRWUtils = require("./krw-utils");
class ValidationUtils {
  /**
   * 거래 입력값 유효성 검사
   */
  static validateTradeInput(market, side, type, price, quantity) {
    const errors = [];

    // 필수 필드 검사
    if (!market) errors.push("market은 필수입니다.");
    if (!side || !["bid", "ask"].includes(side)) {
      errors.push("side는 'bid' 또는 'ask'이어야 합니다.");
    }
    if (!type || !["market", "limit"].includes(type)) {
      errors.push("type은 'market' 또는 'limit'이어야 합니다.");
    }

    // 숫자 변환 및 유효성 검사
    const normalizedPrice = KRWUtils.parseNumber(price);
    const normalizedQuantity = KRWUtils.parseNumber(quantity);

    if (type === "limit") {
      if (isNaN(normalizedPrice) || normalizedPrice <= 0) {
        errors.push("지정가 주문에는 유효한 가격이 필요합니다.");
      }
      if (isNaN(normalizedQuantity) || normalizedQuantity <= 0) {
        errors.push("지정가 주문에는 유효한 수량이 필요합니다.");
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      normalizedPrice,
      normalizedQuantity,
    };
  }

  /**
   * API 파라미터 유효성 검사
   */
  static validateApiParams(params, required) {
    const missing = required.filter((param) => !params[param]);
    return {
      isValid: missing.length === 0,
      missing,
    };
  }
}

module.exports = ValidationUtils;
