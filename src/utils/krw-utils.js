// src/utils/krw-utils.js
class KRWUtils {
  /**
   * 원화 금액을 정수로 변환 (소수점 완전 제거)
   */
  static toInteger(amount) {
    const num = Number(amount) || 0;
    return Math.floor(Math.abs(num)) * Math.sign(num);
  }

  /**
   * 거래 총액 계산 후 정수로 변환
   */
  static calculateTotal(price, quantity) {
    const total = Number(price) * Number(quantity);
    return this.toInteger(total);
  }

  /**
   * 문자열에서 콤마 제거 후 숫자 변환
   */
  static parseNumber(value) {
    if (typeof value === "string") {
      return Number(value.replace(/,/g, "")) || 0;
    }
    return Number(value) || 0;
  }

  /**
   * 잔고 데이터 처리 (원화는 정수로)
   */
  static processBalance(balance) {
    return {
      ...balance,
      krw_balance: this.toInteger(balance.krw_balance),
    };
  }

  /**
   * 거래 데이터 처리 (원화는 정수로)
   */
  static processTransaction(transaction) {
    return {
      ...transaction,
      price: this.toInteger(transaction.price),
      total_amount: this.toInteger(transaction.total_amount),
    };
  }
}

module.exports = KRWUtils;
