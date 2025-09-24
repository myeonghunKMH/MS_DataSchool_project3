/**
 * Technical Indicator Calculation Module
 * Creates a global TechnicalIndicatorManager object.
 */

const TechnicalIndicatorManager = (() => {

    // Helper to calculate Simple Moving Average
    const sma = (data, period) => {
        const result = [];
        for (let i = 0; i <= data.length - period; i++) {
            const slice = data.slice(i, i + period);
            const sum = slice.reduce((acc, val) => acc + val, 0);
            result.push(sum / period);
        }
        return result;
    };

    // 1. Relative Strength Index (RSI)
    const calculateRSI = (candles, period = 14) => {
        if (candles.length < period) return null;
        const closePrices = candles.map(c => c.close);

        let gains = 0;
        let losses = 0;

        for (let i = 1; i <= period; i++) {
            const diff = closePrices[i] - closePrices[i-1];
            if (diff > 0) gains += diff;
            else losses -= diff;
        }

        let avgGain = gains / period;
        let avgLoss = losses / period;

        for (let i = period + 1; i < closePrices.length; i++) {
            const diff = closePrices[i] - closePrices[i-1];
            if (diff > 0) {
                avgGain = (avgGain * (period - 1) + diff) / period;
                avgLoss = (avgLoss * (period - 1)) / period;
            } else {
                avgGain = (avgGain * (period - 1)) / period;
                avgLoss = (avgLoss * (period - 1) - diff) / period;
            }
        }

        if (avgLoss === 0) return { value: 100, interpretation: '완전 과매수 상태' };

        const rs = avgGain / avgLoss;
        const rsi = 100 - (100 / (1 + rs));
        
        let interpretation = '중립';
        if (rsi > 70) interpretation = '과매수 상태';
        else if (rsi < 30) interpretation = '과매도 상태';

        return { value: parseFloat(rsi.toFixed(2)), interpretation };
    };

    // 2. Moving Average Convergence Divergence (MACD)
    const calculateMACD = (candles, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) => {
        if (candles.length < slowPeriod) return null;
        const closePrices = candles.map(c => c.close);

        const ema = (data, period) => {
            const k = 2 / (period + 1);
            let emaValues = [data[0]];
            for (let i = 1; i < data.length; i++) {
                emaValues.push(data[i] * k + emaValues[i-1] * (1 - k));
            }
            return emaValues;
        };

        const emaFast = ema(closePrices, fastPeriod);
        const emaSlow = ema(closePrices, slowPeriod);
        const macdLine = emaFast.map((val, i) => val - emaSlow[i]);
        const signalLine = ema(macdLine, signalPeriod);
        const histogram = macdLine.map((val, i) => val - signalLine[i]);

        const lastMacd = macdLine[macdLine.length - 1];
        const lastSignal = signalLine[signalLine.length - 1];

        let interpretation = '중립';
        if (lastMacd > lastSignal && histogram[histogram.length-2] < 0) {
            interpretation = '강세 신호 (골든크로스)';
        } else if (lastMacd < lastSignal && histogram[histogram.length-2] > 0) {
            interpretation = '약세 신호 (데드크로스)';
        }

        return {
            value: parseFloat(lastMacd.toFixed(2)),
            signal: parseFloat(lastSignal.toFixed(2)),
            interpretation
        };
    };

    // 3. Bollinger Bands
    const calculateBollingerBands = (candles, period = 20, stdDev = 2) => {
        if (candles.length < period) return null;
        const closePrices = candles.map(c => c.close).slice(-period);
        
        const middle = closePrices.reduce((acc, val) => acc + val, 0) / period;
        const std = Math.sqrt(closePrices.map(val => Math.pow(val - middle, 2)).reduce((acc, val) => acc + val, 0) / period);
        
        const upper = middle + (std * stdDev);
        const lower = middle - (std * stdDev);
        const lastPrice = closePrices[closePrices.length - 1];

        let interpretation = '밴드 내 움직임';
        if (lastPrice > upper) interpretation = '상단 밴드 돌파 (과매수 가능성)';
        else if (lastPrice < lower) interpretation = '하단 밴드 돌파 (과매도 가능성)';
        else if (lastPrice > middle) interpretation = '중심선 위에서 움직임 (상승 추세)';
        else interpretation = '중심선 아래에서 움직임 (하락 추세)';

        return {
            upper: parseFloat(upper.toFixed(2)),
            middle: parseFloat(middle.toFixed(2)),
            lower: parseFloat(lower.toFixed(2)),
            interpretation
        };
    };

    // 4. Ichimoku Cloud
    const calculateIchimokuCloud = (candles, p1 = 9, p2 = 26, p3 = 52) => {
        if (candles.length < p3) return null;
        const relevantCandles = candles.slice(-p3);

        const high = (period) => Math.max(...relevantCandles.slice(-period).map(c => c.high));
        const low = (period) => Math.min(...relevantCandles.slice(-period).map(c => c.low));

        const conversionLine = (high(p1) + low(p1)) / 2; // 전환선
        const baseLine = (high(p2) + low(p2)) / 2; // 기준선
        
        const leadingSpanA = (conversionLine + baseLine) / 2; // 선행스팬 1
        const leadingSpanB = (high(p3) + low(p3)) / 2; // 선행스팬 2

        const lastPrice = relevantCandles[relevantCandles.length - 1].close;

        let interpretation = '중립';
        if (lastPrice > leadingSpanA && lastPrice > leadingSpanB && leadingSpanA > leadingSpanB) {
            interpretation = '강력한 강세 (정배열 구름대 위)';
        } else if (lastPrice < leadingSpanA && lastPrice < leadingSpanB && leadingSpanA < leadingSpanB) {
            interpretation = '강력한 약세 (역배열 구름대 아래)';
        } else if (lastPrice > leadingSpanA && lastPrice > leadingSpanB) {
            interpretation = '강세 (구름대 위)';
        } else if (lastPrice < leadingSpanA && lastPrice < leadingSpanB) {
            interpretation = '약세 (구름대 아래)';
        }

        return {
            conversionLine: parseFloat(conversionLine.toFixed(2)),
            baseLine: parseFloat(baseLine.toFixed(2)),
            leadingSpanA: parseFloat(leadingSpanA.toFixed(2)),
            leadingSpanB: parseFloat(leadingSpanB.toFixed(2)),
            interpretation
        };
    };

    // 5. Volume Profile (Simplified)
    const calculateVolumeProfile = (candles, numBuckets = 12) => {
        if (candles.length === 0) return null;
        const relevantCandles = candles.slice(-100); // Use last 100 candles for profile

        const maxPrice = Math.max(...relevantCandles.map(c => c.high));
        const minPrice = Math.min(...relevantCandles.map(c => c.low));
        const bucketSize = (maxPrice - minPrice) / numBuckets;

        const buckets = Array(numBuckets).fill(0);
        relevantCandles.forEach(c => {
            const priceBucket = Math.floor((c.close - minPrice) / bucketSize);
            const validBucket = Math.min(numBuckets - 1, Math.max(0, priceBucket));
            buckets[validBucket] += c.volume;
        });

        const maxVolume = Math.max(...buckets);
        const pocIndex = buckets.indexOf(maxVolume);
        const poc = minPrice + (pocIndex * bucketSize) + (bucketSize / 2);

        return {
            poc: parseFloat(poc.toFixed(2)),
            interpretation: `${parseFloat(poc.toFixed(2))} 부근에 가장 많은 거래량 집중 (주요 지지/저항선)`
        };
    };

    // Main function to get all indicators
    const calculateAllIndicators = (candles) => {
        // Assuming candles are sorted from oldest to newest
        if (!candles || candles.length < 52) {
            return null;
        }

        return {
            rsi: calculateRSI(candles),
            macd: calculateMACD(candles),
            bollingerBands: calculateBollingerBands(candles),
            ichimokuCloud: calculateIchimokuCloud(candles),
            volumeProfile: calculateVolumeProfile(candles)
        };
    };

    // Expose public functions
    return {
        calculateAllIndicators
    };

})();