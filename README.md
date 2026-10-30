# Moments

DM 중심의 소셜 앱 프로토타입입니다. Express, Socket.IO, SQLite로 계정과 게시물, 대화를 저장합니다.

## 실행

Node.js 22.13 이상이 필요합니다.

```sh
npm install
cp .env.example .env
npm start
```

기본 포트는 `3000`입니다. 다른 포트를 사용하려면 `.env`에서 `PORT` 값을 변경하세요.

브라우저에서 `http://localhost:3000`을 엽니다. 개발 중 자동 재시작은 `npm run dev`를 사용합니다. SQLite 데이터베이스는 루트의 `moments.db`에 생성됩니다.

## Google 로그인 설정

1. Google Cloud Console에서 OAuth 2.0 Client ID를 생성합니다.
2. "Authorized JavaScript origins"에 로컬 주소를 추가합니다.
   - 예: `http://localhost:3000`
3. 생성된 Client ID를 `.env`의 `GOOGLE_CLIENT_ID`에 넣습니다.
4. 서버를 다시 시작하면 Google 로그인 버튼이 활성화됩니다.

```env
PORT=3000
PUBLIC_BASE_URL=http://localhost:3000
GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID
```

## 다른 기기에서 테스트

같은 네트워크에서는 서버를 실행한 기기의 주소와 포트 `3000`(또는 설정한 포트)으로 접속합니다. Codespaces에서는 Ports 탭에서 해당 포트를 공개한 다음 전달된 주소를 공유합니다. 두 사용자가 각각 가입하면 사용자 검색으로 서로 대화를 시작할 수 있습니다.

이 앱은 데모용입니다. 공개 배포 전에는 HTTPS, 백업, 비밀번호 재설정, 스팸/로그인 시도 제한, 운영용 DB와 이미지 저장소를 구성해야 합니다.