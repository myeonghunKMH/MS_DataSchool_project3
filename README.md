<<<<<<< HEAD
# 가상 암호화폐 거래 학습 플랫폼
=======
# Project ITC
>>>>>>> bd495ed612e80ca8e4dc5380b9d026c9c1cd0b14

> 암호화폐에 관심은 있지만 실제 투자는 두려워하는 초보자들을 위한 안전한 학습 환경
> UPbit 실시간 데이터로 가상 자금 거래 연습 + 과거 시나리오로 다양한 시장 상황 체험

---

## 🎯 프로젝트 개요

암호화폐 거래 초보자가 **실제 자금 손실 없이** 거래 경험을 쌓을 수 있는 웹 기반 교육 플랫폼

**핵심 가치**

- 안전한 학습 환경: 가상 자금 1,000만원으로 거래 연습
- 실전과 동일한 경험: UPbit API 실시간 시세 및 호가창 데이터
- 과거 시나리오 학습: 2021 급등기, 2022 테라-루나 사태, 2020 팬데믹 재현
- 체계적 피드백: AI 챗봇 상담 + 포트폴리오 분석 리포트

---

## ✨ 주요 기능

### 1. 실시간 거래

- UPbit WebSocket 실시간 시세/호가/체결
- 지정가/시장가 주문, 자동 매칭 엔진
- KRW, BTC, ETH, XRP 다중 자산 관리

### 2. 과거 시나리오 학습

- 시나리오 1: 2021 비트코인 급등기
- 시나리오 2: 2022 테라-루나 사태
- 시나리오 3: 2020 코로나 팬데믹
- 60분봉 차트 타임머신 재생

### 3. 투자 리포트

- 일별/월별 수익률 (MtM 기준)
- 포트폴리오 분석, 피어 비교
- FIFO 실현손익 계산

### 4. AI 챗봇

- OpenAI LLM 투자 상담
- 사용자 포트폴리오 기반 맞춤 답변

### 5. 암호화폐 뉴스

- Azure MySQL 뉴스 크롤링 DB
- 감성 분석, 페이지네이션

### 6. QnA 커뮤니티

- 질문/답변 게시판, 관리자 답변

### 7. 마이페이지

- 보유자산 현황, 거래 이력
- 회원 탈퇴(14일 유예기간)

---

## 🛠 기술 스택

**Backend**: Node.js, Express, WebSocket (ws), MySQL, Keycloak
**Frontend**: HTML5, CSS3, Vanilla JS, Chart.js
**External API**: UPbit WebSocket, OpenAI LLM
**Infra**: Azure DevOps CI/CD, Docker, AKS, Azure Key Vault

---

## 🏗 시스템 아키텍처

```
[Browser] → [Express + WebSocket] → [Keycloak 인증]
                    ↓
         ┌──────────┴──────────┐
    [MySQL 거래DB]      [Azure MySQL 뉴스DB]
         ↓                     ↓
   [UPbit API]           [OpenAI API]
```

**주요 모듈**

```
server.js
  ├── realtime.js (실시간 거래)
  ├── scenario.js (과거 시나리오)
  ├── report.js (리포트)
  ├── news.js (뉴스)
  ├── qna.js (커뮤니티)
  └── trading/ (주문 처리 + 매칭 엔진)
```

---

## 📂 디렉토리 구조

```
bitcoin-chart-node/
├── server.js                  # 메인 진입점
├── services/                  # DB, Email, Keycloak
├── trading/                   # 거래 핵심 로직
│   ├── services/              # 주문 처리, 매칭 엔진
│   ├── managers/              # DB, WebSocket 관리
│   └── routes/                # REST API
├── public/                    # HTML, CSS, JS
│   ├── realtime.html
│   ├── scenarios/
│   ├── crypto.html (AI 챗봇)
│   ├── news.html
│   ├── report.html
│   ├── qna.html
│   └── mypage.html
└── DEVELOPMENT_GUIDE.md       # 개발/배포 가이드
```

---

## 📘 개발 가이드

자세한 개발 및 배포 절차는 **[DEVELOPMENT_GUIDE.md](./DEVELOPMENT_GUIDE.md)** 참고

**간단 요약**

- 환경변수: Azure Key Vault 중앙 관리
- 배포: `git push origin main` → Azure Pipeline 자동 배포
- 인증: Keycloak (OAuth 2.0)

---

## 📄 라이선스

ISC

---
