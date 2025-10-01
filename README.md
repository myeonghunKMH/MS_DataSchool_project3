# Bitcoin Chart Node

실시간 비트코인 거래 시스템

## 개요

이 프로젝트는 WebSocket 기반의 실시간 비트코인 차트 및 거래 시스템입니다. 사용자는 실시간으로 비트코인 가격을 확인하고, 매수/매도 주문을 생성하며, 주문 매칭 엔진을 통해 거래를 체결할 수 있습니다.

## 주요 기능

- **실시간 차트**: WebSocket을 통한 실시간 비트코인 가격 업데이트
- **주문 관리**: 매수/매도 주문 생성 및 관리
- **자동 매칭 엔진**: 주문 간 자동 매칭 및 체결
- **거래 내역**: 체결된 거래 이력 조회
- **Keycloak 인증**: 안전한 사용자 인증 및 세션 관리
- **데이터베이스 연동**: MySQL 기반 거래 데이터 저장

## 기술 스택

- **Backend**: Node.js, Express
- **Database**: MySQL
- **WebSocket**: ws
- **Authentication**: Keycloak
- **Frontend**: HTML, CSS, JavaScript
- **API Communication**: Axios

## 프로젝트 구조

```
bitcoin-chart-node/
├── src/
│   ├── js/
│   │   └── app.js              # 메인 서버 애플리케이션
│   ├── managers/
│   │   ├── database-manager.js  # 데이터베이스 관리
│   │   └── websocket-manager.js # WebSocket 연결 관리
│   ├── services/
│   │   ├── trading-service.js   # 거래 로직
│   │   └── order-matching-engine.js # 주문 매칭 엔진
│   ├── routes/
│   │   └── api-router.js        # REST API 라우터
│   ├── utils/
│   │   ├── validation-utils.js  # 유효성 검사
│   │   └── krw-utils.js         # 원화 관련 유틸리티
│   └── config.js                # 설정 파일
├── public/                      # 정적 파일 (HTML, CSS, JS)
├── trading/
│   └── managers/
│       └── database-manager.js  # 거래 데이터베이스 관리
├── database.js                  # 데이터베이스 연결
├── email.js                     # 이메일 기능
├── keycloak-config.js           # Keycloak 설정
└── server.js                    # 서버 진입점
```

## 시작하기

### 사전 요구사항

- Node.js (v14 이상)
- MySQL
- Keycloak 서버

### 설치

```bash
# 의존성 설치
npm install
```

### 환경 변수 설정

프로젝트 루트에 `.env` 파일을 생성하고 다음 정보를 입력하세요:

```env
# Database
DB_HOST=your_database_host
DB_USER=your_database_user
DB_PASSWORD=your_database_password
DB_NAME=your_database_name

# Keycloak
KEYCLOAK_URL=your_keycloak_url
KEYCLOAK_REALM=your_realm
KEYCLOAK_CLIENT_ID=your_client_id
KEYCLOAK_CLIENT_SECRET=your_client_secret

# Server
PORT=3000
```

### 실행

```bash
# 서버 시작
npm start
```

서버는 기본적으로 `http://localhost:3000`에서 실행됩니다.

## API 엔드포인트

### 주문 관리
- `POST /api/orders` - 새 주문 생성
- `GET /api/orders` - 주문 목록 조회
- `DELETE /api/orders/:id` - 주문 취소

### 거래 내역
- `GET /api/trades` - 체결된 거래 내역 조회

### 사용자
- `GET /api/user` - 사용자 정보 조회
- `GET /api/balance` - 잔액 조회

## WebSocket 이벤트

### 클라이언트 → 서버
- `subscribe` - 실시간 데이터 구독
- `createOrder` - 주문 생성
- `cancelOrder` - 주문 취소

### 서버 → 클라이언트
- `priceUpdate` - 가격 업데이트
- `orderUpdate` - 주문 상태 업데이트
- `tradeExecuted` - 거래 체결 알림
- `balanceUpdate` - 잔액 업데이트

## 개발

자세한 개발 및 배포 가이드는 [DEVELOPMENT_GUIDE.md](./DEVELOPMENT_GUIDE.md)를 참고하세요.

## 라이선스

ISC
