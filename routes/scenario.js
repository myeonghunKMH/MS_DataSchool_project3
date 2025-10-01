const { pool } = require("../config/database.js");

module.exports = function registerScenarioRoutes(app) {

// ============================ #시나리오1 ============================

app.get("/api/history", async (req, res) => {
  const { market, limit = 10000 } = req.query;
  if (!market) return res.status(400).json({ error: "market 파라미터가 필요합니다." });

  const tableMap = {
    btc: "crypto_60m_KRW_BTC"
  };
  const table = tableMap[(market || "").toLowerCase()];
  if (!table) {
    return res.status(400).json({
      error: "지원하지 않는 market입니다. 사용 가능: btc, eth, xrp",
    });
  }

  try {
    const [rows] = await pool.query(
      `SELECT 
        candle_date_time_kst,
        opening_price,
        high_price,
        low_price,
        trade_price,
        candle_acc_trade_volume AS volume
      FROM ${table}
      WHERE unit = 0
      ORDER BY candle_date_time_kst ASC
      LIMIT ?`,
      [parseInt(limit)]
    );

    if (!rows.length) {
      return res.status(404).json({ error: `${market.toUpperCase()} 데이터를 찾을 수 없습니다.` });
    }
    res.json(rows);
  } catch (error) {
    console.error(`${market.toUpperCase()} 데이터 조회 오류:`, error);
    res.status(500).json({
      error: "데이터베이스 조회 중 오류가 발생했습니다.",
    });
  }
});

app.get("/api/markets", async (req, res) => {
  try {
    const tableMap = {
      btc: "crypto_60m_KRW_BTC",
    };

    const markets = [];
    for (const [market, table] of Object.entries(tableMap)) {
      try {
        const [cnt] = await pool.query(`SELECT COUNT(*) AS cnt FROM ${table} WHERE unit = 0`);
        const [last] = await pool.query(
          `SELECT candle_date_time_kst, trade_price
          FROM ${table}
          WHERE unit = 0
          ORDER BY candle_date_time_kst DESC
          LIMIT 1`
        );
        markets.push({
          market: market.toUpperCase(),
          symbol: `${market.toUpperCase()}/KRW`,
          dataCount: cnt[0].cnt,
          latestPrice: last[0]?.trade_price || 0,
          latestTime: last[0]?.candle_date_time_kst || null,
        });
      } catch (e) {
        console.error(`${market} 마켓 정보 조회 오류:`, e);
        markets.push({
          market: market.toUpperCase(),
          symbol: `${market.toUpperCase()}/KRW`,
          dataCount: 0,
          latestPrice: 0,
          latestTime: null,
          error: "데이터 조회 실패",
        });
      }
    }
    res.json(markets);
  } catch (err) {
    console.error("마켓 목록 조회 오류:", err);
    res.status(500).json({ error: "마켓 목록 조회 실패" });
  }
});

// (예전 뉴스 — 상세 서술 포함)
app.get("/api/scenario1/news", (req, res) => {
  res.json([
    {
      time: "2021-05-12 09:00:00",
      title: "테슬라, 비트코인 결제 전격 중단",
      description:
        "테슬라는 자사 차량 구매 시 비트코인 결제를 더 이상 지원하지 않겠다고 발표했다. 일론 머스크는 전력 소모와 환경 문제를 이유로 들었으며, 발표 직후 비트코인과 이더리움 가격이 급락했다. 시장에서는 친환경 정책 기조와 맞물려 암호화폐 규제 가능성이 더 커졌다는 해석이 나오며 투자심리가 빠르게 위축되었다."
    },
    {
      time: "2021-05-20 15:00:00",
      title: "중국 금융기관, 암호화폐 서비스 전면 금지 지침",
      description:
        "중국 금융당국이 은행과 결제업체가 암호화폐 관련 계좌 개설, 거래 중개, 청산, 결제 서비스를 제공하지 못하도록 전면 금지했다. 개인 보유 자체는 허용됐으나 제도권 금융과의 연결 고리가 끊기며 불안 심리가 확산됐다. 이 조치 이후 BTC·ETH·XRP 등 주요 코인이 동반 약세를 보였다."
    },
    {
      time: "2021-05-21 15:00:00",
      title: "중국 국무원, 채굴·거래 강력 단속 공식화",
      description:
        "류허 부총리가 주재한 국무원 금융안정발전위원회 회의에서 비트코인 채굴과 거래에 대한 전면적인 단속 방침이 공식화되었다. 중앙 정부 차원의 첫 강경 발언으로 시장 충격이 컸으며, 비트코인은 4만 달러 초반에서 3만 달러 중반대로 급락했다. 일주일 만에 20% 이상 하락하며 패닉셀이 발생했다."
    },
    {
      time: "2021-05-24 10:00:00",
      title: "비트코인, 3만 달러 붕괴",
      description:
        "연이은 악재로 비트코인 가격이 3만 달러 선이 무너지며 투자자들의 공포가 극에 달했다. 패닉셀로 거래소마다 대규모 매도 물량이 쏟아졌고, 단기 반등 시도는 번번이 막혔다. 시장 변동성이 극도로 확대되며 알트코인들도 동반 폭락했다."
    },
    {
      time: "2021-05-28 14:00:00",
      title: "기관 투자자, 매도세 강화",
      description:
        "헤지펀드와 대형 기관 투자자들이 추가 하락을 우려하며 보유 자산을 대거 매도했다. 일부 보고서에서는 암호화폐가 위험자산으로 분류되며 자산 포트폴리오에서 축소되는 움직임이 나타났다고 분석했다. 기관발 매도세가 시장 전반에 추가 압박을 가했다."
    },
    {
      time: "2021-06-01 11:00:00",
      title: "SEC 규제 압박, 리플 소송 연장",
      description:
        "미국 증권거래위원회(SEC)가 리플(XRP) 소송을 연장하고, 이더리움의 증권성 여부를 검토하겠다는 방침을 밝혔다. 규제 불확실성이 확대되면서 글로벌 거래소의 암호화폐 상장 기준도 강화될 수 있다는 전망이 나왔다. XRP는 직접 타격을 받았고 ETH 역시 투자 심리 위축으로 하락세를 이어갔다."
    },
    {
      time: "2021-06-04 18:00:00",
      title: "머스크 발언에 단기 급등락",
      description:
        "일론 머스크가 트위터를 통해 비트코인과 이더리움 관련 긍정적인 뉘앙스의 발언을 내놓자, 단기적으로 가격이 반등했다. 그러나 불과 몇 시간 만에 부정적인 트윗이 이어지면서 다시 급락세로 전환되었다. 머스크의 발언 한 마디가 시장 변동성을 좌우하는 모습이 뚜렷하게 나타났다."
    },
    {
      time: "2021-06-09 09:00:00",
      title: "국제 결제망 불확실성 부각",
      description:
        "국제 송금망과 관련한 규제 불확실성이 다시 언급되며 XRP 등 결제 특화 코인들이 압박을 받았다. 글로벌 금융망에서 암호화폐 활용도를 제한하려는 정책이 등장할 수 있다는 우려가 확산되면서, 투자자들은 관련 종목을 대거 매도했다."
    },
    {
      time: "2021-06-15 16:00:00",
      title: "중국 채굴장 셧다운, 해시레이트 급락",
      description:
        "중국 내 대규모 채굴장이 정부 단속으로 전면 셧다운에 들어가면서 비트코인 해시레이트가 급격히 감소했다. 채굴 난이도 하락이 뒤따랐고, 네트워크 보안 안정성에 대한 우려까지 제기되었다. 채굴자들이 대량 매도에 나서면서 단기 약세가 심화되었다."
    },
    {
      time: "2021-06-20 08:00:00",
      title: "미국 인플레이션 지표 발표",
      description:
        "미국의 물가 지표가 시장 예상치를 크게 웃돌면서 위험자산 전반에 매도세가 강화되었다. 인플레이션 압력이 높아지면 연준의 긴축 가속화가 불가피하다는 전망이 나오며 암호화폐 시장에도 직접 충격이 가해졌다. BTC와 ETH 모두 큰 폭의 하락세를 기록했다."
    }
  ]);
});


// ============================ #시나리오2 ============================

app.get("/api/scenario2", async (req, res) => {
  try {
    const { market = "KRW-ETH", start, end } = req.query;
    const tableMap = { "KRW-ETH": "ETH_daily" };
    const table = tableMap[market];
    if (!table) {
      return res.status(400).json({ error: "지원하지 않는 market입니다. 현재는 KRW-ETH만 지원합니다." });
    }

    const where = [];
    const params = [];
    if (start) { where.push(`DATE(candle_date_time_kst) >= ?`); params.push(start); }
    if (end) { where.push(`DATE(candle_date_time_kst) <= ?`); params.push(end); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const sql = `
      SELECT
        market,
        candle_date_time_utc,
        candle_date_time_kst,
        opening_price,
        high_price,
        low_price,
        trade_price,
        timestamp,
        candle_acc_trade_price,
        candle_acc_trade_volume,
        unit
      FROM ${table}
      ${whereSql}
      ORDER BY candle_date_time_kst ASC
    `;

    const [rows] = await pool.query(sql, params);
    // ✅ 실제 테이블 컬럼에 맞게 변환
    res.json(rows.map(r => ({
      candle_date_time_kst: r.candle_date_time_kst,
      timestamp: Number(r.timestamp),
      opening_price: Number(r.opening_price),
      high_price: Number(r.high_price),
      low_price: Number(r.low_price),
      trade_price: Number(r.trade_price),
      volume: Number(r.candle_acc_trade_volume || 0),
    })));
  } catch (err) {
    console.error("시나리오2 데이터 조회 오류:", err);
    res.status(500).json({ error: "시나리오2 데이터 조회 실패" });
  }
});

// (예전 뉴스 — 시나리오2)
app.get("/api/scenario2/news", (req, res) => {
  res.json([
    {
      time: "2025-07-14 09:00:00",
      title: "ETH 옵션 만기 후 매수세 강화",
      description:
        "7월 중순 대규모 옵션 만기가 지나면서 파생상품 시장의 불확실성이 해소되자 기관과 개인 투자자들의 신규 매수세가 빠르게 유입되었다. 거래량이 뚜렷하게 증가하며 단기 랠리에 대한 기대가 커졌고, 기술적 저항선 돌파 가능성이 확산되면서 투자심리가 크게 개선되었다."
    },
    {
      time: "2025-07-17 15:00:00",
      title: "비트코인 상승 랠리, ETH 동반 강세",
      description:
        "비트코인이 심리적 저항선인 70,000달러를 재돌파하면서 글로벌 투자 심리가 회복되었고, 이 분위기는 알트코인 전반으로 확산되었다. 특히 ETH가 가장 큰 수혜를 입으며 네트워크 수수료 하락과 거래량 급증이 맞물려 단기간 5% 이상 상승세를 기록했다."
    },
    {
      time: "2025-07-20 00:00:00",
      title: "이더리움 $3,800 돌파",
      description:
        "대형 투자자들의 집중 매수와 기술적 모멘텀이 결합되며 ETH 가격이 3,800달러를 돌파했다. 이 구간은 시장에서 중기 저항선으로 인식되던 자리였기에 추가 상승 가능성에 대한 기대가 높아졌고, 거래소 전반의 유동성이 확대되면서 투자심리가 한층 강화되었다."
    },
    {
      time: "2025-07-23 01:00:00",
      title: "SharpLink, 79,949 ETH 매입",
      description:
        "글로벌 핀테크 기업 SharpLink이 약 8만 ETH를 평균 3,238달러에 매수했다고 발표했다. 이번 대규모 매수로 보유량은 총 360,807 ETH로 증가했으며, 기관 차원의 장기적 신뢰가 시장에 확인되자 투자자들의 기대감이 높아지고 ETH의 단기 가격 탄력이 크게 강화되었다."
    },
    {
      time: "2025-07-26 12:00:00",
      title: "Ethereum Foundation 'Torch' NFT 발행",
      description:
        "이더리움 재단은 창립 10주년을 기념해 한정판 NFT 'Torch'를 발행하고 오는 7월 30일 소각할 계획이라고 밝혔다. 커뮤니티 참여가 활발해지며 NFT 발행 소식은 ETH의 브랜드 가치와 희소성을 높이는 긍정적 요인으로 작용했고, 투자자들의 관심이 다시금 집중되었다."
    },
    {
      time: "2025-07-29 18:00:00",
      title: "ETH 수요 급증 분석",
      description:
        "7월 한 달 동안 ETH 가격이 약 65% 상승하며 공급 부족 현상이 뚜렷하게 나타났다. 기관과 개인 모두 보유 물량을 확대하는 흐름이 이어졌고, 온체인 데이터 역시 장기 보유 지갑이 늘어나는 모습을 보여주며 강세장이 지속될 것이라는 전망이 우세해졌다."
    },
    {
      time: "2025-08-02 03:00:00",
      title: "ETH ETF 20일 연속 순유입 종료",
      description:
        "ETH ETF에서 20일 연속 이어지던 순유입이 마무리되고 1억 5천만 달러 규모의 순유출이 발생했다. 시장에서는 단기 조정 가능성이 제기되었으나, 여전히 기관 자금이 대거 머무르고 있다는 점에서 중장기적 상승 기대감은 크게 꺾이지 않았다."
    },
    {
      time: "2025-08-09 11:00:00",
      title: "미국 스테이블코인 규제 명확화 발표",
      description:
        "미국 정부가 스테이블코인 규제 가이드라인을 명확히 제시하면서 불확실성이 크게 해소되었다. 이 조치는 시장 신뢰도를 높이며 투자 환경을 안정화시켰고, ETH 가격에도 긍정적 영향을 미치며 단기 반등세를 견인했다."
    },
    {
      time: "2025-08-12 22:00:00",
      title: "기업 보유 ETH 127% 급증",
      description:
        "최근 보고서에 따르면 글로벌 주요 기업들의 ETH 보유량이 전월 대비 127% 급증해 2.7백만 개(116억 달러 규모)에 달했다. 기관의 보유 확대는 이더리움에 대한 장기적 신뢰를 반영하며 시장 전반의 상승 압력을 강화하는 핵심 요인으로 작용했다."
    }
  ]);
});

  // ============================ #시나리오3 ============================

  // 시나리오3 설정(API로 제공: 기간 + 15일 윈도우)
  app.get("/api/scenario3/config", (req, res) => {
    res.json({
      range: { start: "2023-06-01", end: "2023-07-31" },
      windowDays: 15
    });
  });

  // 시나리오3 뉴스(API): 요구하신 흐름을 타임라인으로 구성 (가짜 뉴스)
  app.get("/api/scenario3/news", (req, res) => {
    const news = [
      // 6월 중순: BTC 단기 강세
      {
        time: "2023-06-14 10:00:00",
        title: "비트코인, 대형 기관 매수 포착…단기 강세 전환",
        description: "衝(숏) 커버와 매수 수요 결합으로 위험자산 선호 회복. 단기 저항 구간 돌파 시 가속 기대.",
        market: "btc"
      },
      {
        time: "2023-06-16 11:30:00",
        title: "BTC 파생시장 펀딩률 플러스 전환",
        description: "레버리지 롱 포지션 우위로 단기 변동성 확대 경고. 손절 관리 필요.",
        market: "btc"
      },
      // 6월 하순: 강세 피크 뒤 숨 고르기
      {
        time: "2023-06-23 14:00:00",
        title: "비트코인 급등 후 숨 고르기…거래대금 둔화",
        description: "현물 거래대금이 피크 대비 30% 감소. 조정 또는 박스권 가능성.",
        market: "btc"
      },
      // 7월 초: XRP 기대감 재점화
      {
        time: "2023-07-05 09:30:00",
        title: "XRP 커뮤니티, 판결 임박설에 관심 집중",
        description: "법원 문건 비공개 해제 여부가 쟁점으로 부상. 특정 주소군 매집 추정.",
        market: "xrp"
      },
      // 7/13 판결 이벤트
      {
        time: "2023-07-13 23:00:00",
        title: "법원, XRP 일부 거래 '증권 아님' 판단",
        description: "기관판매와 구분되는 공개시장 거래에 대한 판단이 호재로 해석. 단기 급등 후 변동성 확대.",
        market: "xrp"
      },
      // 7월 중하순: 판결 후 후속 보도 & 시장 반응
      {
        time: "2023-07-14 09:10:00",
        title: "거래소, XRP 일부 상장 재개 검토",
        description: "유동성 회복 기대감 확산. 단기 과열 리스크 병존.",
        market: "xrp"
      },
      {
        time: "2023-07-18 13:20:00",
        title: "알트코인 전반 강세…비트코인 도미넌스 하락",
        description: "XRP 판결 여파로 리스크 온 확대. BTC는 박스권 상단 테스트.",
        market: "both"
      },
      {
        time: "2023-07-24 10:40:00",
        title: "리플-SEC 항소 가능성 거론…변동성 재확대",
        description: "법적 절차가 이어질 수 있다는 관측에 차익실현 경계감 부상.",
        market: "xrp"
      },
      // 7월 말: 월말 효과 & 방향성 탐색
      {
        time: "2023-07-28 15:30:00",
        title: "월말 리밸런싱 수요…BTC·XRP 혼조",
        description: "기관 리밸런싱 물량 대기. 박스권 상·하단 이탈 시 추세 재형성 가능.",
        market: "both"
      }
    ];
    res.json(news);
  });

  // (BTC/XRP 일봉 조회 — 그대로 유지)
  const dailyTableMap = { btc: "btc_daily_0601", xrp: "xrp_daily_0601" };
  const allowedDailyTables = new Set(Object.values(dailyTableMap));

  app.get("/api/daily", async (req, res) => {
    try {
      const { asset, start, end, table } = req.query;
      if (!asset || !start || !end) {
        return res.status(400).json({ error: "asset, start, end 파라미터가 필요합니다." });
      }
      let tableName = dailyTableMap[(asset || "").toLowerCase()];
      if (table) {
        const safe = /^[A-Za-z0-9_]+$/.test(table) && allowedDailyTables.has(table);
        if (!safe) return res.status(400).json({ error: "허용되지 않은 테이블명입니다." });
        tableName = table;
      }
      if (!tableName) return res.status(400).json({ error: "지원하지 않는 asset입니다. (btc|xrp)" });

      const [rows] = await pool.query(
        `
        SELECT
          CAST(candle_date_time_kst AS DATETIME) AS candle_date_time_kst,
          opening_price,
          high_price,
          low_price,
          trade_price,
          IFNULL(candle_acc_trade_volume, 0) AS volume
        FROM ${tableName}
        WHERE DATE(candle_date_time_kst) >= ?
          AND DATE(candle_date_time_kst) <= ?
        ORDER BY candle_date_time_kst ASC
        `,
        [start, end]
      );

      if (!rows || rows.length === 0) {
        return res.status(404).json({
          error: "해당 구간 데이터가 없습니다.",
          meta: { asset, start, end, table: tableName },
        });
      }
      res.json(rows);
    } catch (err) {
      console.error("일봉 데이터 조회 오류:", err);
      res.status(500).json({ error: "일봉 데이터 조회 중 오류가 발생했습니다." });
    }
  });
};
