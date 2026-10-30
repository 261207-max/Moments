# Moments

DM 중심의 소셜 앱 프로토타입입니다. Express, Socket.IO, SQLite로 계정과 게시물, 24시간 스토리, 1:1 및 그룹 대화를 저장합니다.

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
YOUTUBE_API_KEY=YOUR_YOUTUBE_DATA_API_KEY
```

## 자동 YouTube Shorts 추천

자동 추천을 사용하려면 Google Cloud Console에서 YouTube Data API v3를 활성화하고 API 키를 발급해 `.env`의 `YOUTUBE_API_KEY`에 설정합니다. 서버를 다시 시작하면 릴스 피드가 공개 Shorts 검색 결과를 불러옵니다. 키는 서버에서만 사용됩니다.

YouTube는 외부 앱에 개인화된 추천 목록을 제공하지 않습니다. Moments는 공개 `#shorts` 검색 결과를 사용자의 완주·시청·좋아요와 영상 주제로 다시 정렬합니다. API 키가 없어도 직접 추가한 릴스는 계속 볼 수 있습니다.

## 비밀번호 재설정

로그인할 수 없는 계정은 프로젝트 루트에서 아래 명령으로 비밀번호를 재설정할 수 있습니다. 아이디를 입력한 뒤 새 비밀번호는 터미널에 표시되지 않게 입력합니다.

```sh
npm run reset-password
```

재설정 후 해당 계정의 기존 로그인 세션은 종료됩니다.

## 다른 기기에서 테스트

같은 네트워크에서는 서버를 실행한 기기의 주소와 포트 `3000`(또는 설정한 포트)으로 접속합니다. Codespaces에서는 Ports 탭에서 해당 포트를 공개한 다음 전달된 주소를 공유합니다. 두 사용자가 각각 가입하면 사용자 검색으로 서로 대화를 시작할 수 있습니다.

이 앱은 데모용입니다. 공개 배포 전에는 HTTPS, 백업, 비밀번호 재설정, 스팸/로그인 시도 제한, 운영용 DB와 이미지 저장소를 구성해야 합니다.