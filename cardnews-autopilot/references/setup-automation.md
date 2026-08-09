# 자동 모드 세팅 가이드

매일 정해진 시각에 텔레그램으로 초안을 받고, 버튼 한 번으로 인스타에 올리는 구성이다.

**전체 30~60분.** 대부분 Meta 앱 설정에서 걸린다. 순서대로 하면 막힐 일은 없다.

> **비용** 서버가 없다. GitHub Actions(공개 레포 무료), 텔레그램(무료), 인스타 API(무료)만 쓴다.
> **Claude 구독(Pro/Max/Team/Enterprise)이 있으면 전체가 0원**이다 — 구독으로 원고를 쓰기 때문이다.
> 구독이 없으면 Claude API 사용료만 드는데, 하루 1편 기준 **월 1달러** 안쪽이다.

---

## 준비물 체크

- [ ] GitHub 계정
- [ ] 텔레그램 계정
- [ ] 인스타그램 **프로페셔널 계정** (비즈니스 또는 크리에이터)
- [ ] **Claude 구독**(Pro/Max/Team/Enterprise) 또는 Claude API 키 — 자동 스케줄에만 필요

## 로컬에서 먼저 테스트하려면

`.env.example` 을 복사해 `.env` 로 이름을 바꾸고 값을 채우면, 모든 스크립트가 자동으로 읽는다.
환경변수를 매번 손으로 넣을 필요가 없다.

```bash
cp .env.example .env      # Windows: copy .env.example .env
```

`.env` 는 `.gitignore` 에 들어 있어 커밋되지 않는다.

이미 만들어 둔 초안으로 **발행만** 테스트하려면 (Claude API 키 없이 가능):

```bash
node scripts/tick.mjs --draft out/draft.json
```

---

## 1단계 — GitHub 레포 만들기 (5분)

스케줄러와 이미지 호스팅을 한 번에 해결한다.

1. https://github.com/new
2. 레포 이름: 아무거나 (예: `cardnews`)
3. **Public 으로 만든다.**
   - 인스타 API 가 공개 이미지 주소를 요구해서 그렇다
   - 공개 레포는 Actions 실행 시간이 무제한 무료다
   - **토큰은 레포에 안 들어간다.** 전부 Secrets 에 넣으므로 공개해도 안전하다
4. 레포를 클론한 뒤, 이 스킬 폴더를 **`.claude/skills/` 안에** 넣는다

```
<클론한 레포>/
  .claude/
    skills/
      cardnews-autopilot/     ← 이 폴더
```

`.claude/skills/` 여야 Claude Code 가 스킬로 인식한다. 그리고 레포 안이어야 GitHub Actions 가 내려받아 실행할 수 있다. 둘 다 만족하는 자리가 여기다.

```bash
git add .
git commit -m "카드뉴스 자동화"
git push
```

> **`node_modules/` 는 커밋되지 않는다** (스킬의 `.gitignore` 가 막는다). Actions 가 `npm ci` 로 알아서 설치하므로 그게 맞다.
> 반대로 `config/config.json` 은 **반드시 커밋해야 한다.** Actions 가 이 파일을 읽는다. 비밀값은 안 들어가므로 공개돼도 안전하다.

### git 이 `Author identity unknown` 이라고 하면

처음 커밋할 때 나온다. 이름과 메일을 한 번만 등록하면 된다.

```bash
git config user.email "본인메일@example.com"
git config user.name "본인이름"
```

### 로컬 테스트용 토큰 (Actions 만 쓸 거면 건너뛰기)

Actions 안에서는 `GITHUB_TOKEN` 이 자동으로 주입된다. **내 PC 에서 직접 돌려볼 때만** 토큰이 따로 필요하다.

1. https://github.com/settings/personal-access-tokens → **Generate new token**
2. **Repository access** → Only select repositories → 방금 만든 레포 선택
3. **Permissions** → Repository permissions → **Contents** 를 **Read and write** 로
4. 생성된 `github_pat_...` → `.env` 의 `GITHUB_TOKEN`

---

## 2단계 — 텔레그램 봇 (5분)

### 봇 만들기

1. 텔레그램에서 **@BotFather** 검색 → 대화 시작
2. `/newbot` 입력
3. 봇 이름 입력 (표시용, 아무거나) — 예: `내 카드뉴스`
4. 봇 아이디 입력 — **반드시 `bot` 으로 끝나야 한다.** 예: `my_cardnews_bot`
5. `123456789:AAE...` 형태의 토큰이 나온다 → **`TELEGRAM_BOT_TOKEN`**

### 채팅 ID — 스크립트가 알아서 찾아준다

토큰을 `.env` 의 `TELEGRAM_BOT_TOKEN` 에 넣은 뒤 실행한다.

```bash
node scripts/telegram-setup.mjs
```

봇에게 아무 말이나 한 번 보내면 채팅 ID 를 찾아 `.env` 에 자동으로 채우고, 확인 메시지까지 보낸다. JSON 을 들여다볼 일이 없다.

<details>
<summary>직접 찾고 싶다면</summary>

1. 만든 봇과 **대화를 시작하고 아무 말이나 한 번 보낸다** (이걸 안 하면 봇이 나에게 메시지를 못 보낸다)
2. 브라우저에서 `https://api.telegram.org/bot<토큰>/getUpdates` 를 연다
3. `"chat":{"id":123456789` 의 숫자가 `TELEGRAM_CHAT_ID` 다

</details>

---

## 3단계 — 카피 작성 수단 (1~3분)

사람이 없는 시간에 원고를 쓰려면 모델을 부를 수단이 필요하다. **둘 중 하나만** 하면 된다.

### ① Claude 구독이 있다면 — 추가 요금 없음 ⭐

Claude **Pro / Max / Team / Enterprise** 구독자라면 이쪽이다. API 요금이 따로 나가지 않고 구독 사용량만 쓴다.

```bash
npm install -g @anthropic-ai/claude-code
claude setup-token
```

브라우저로 로그인하면 토큰이 나온다 → **`CLAUDE_CODE_OAUTH_TOKEN`**

- **유효기간 1년.** 만료되면 같은 명령으로 다시 발급하면 된다
- 카드뉴스 1편당 사용량은 아주 적어서(입력 3천~7천 토큰) 구독 한도에 거의 영향이 없다

> **토큰은 비밀번호와 같다.** 화면에 뜬 값을 채팅창이나 스크린샷으로 남에게 보내지 않는다. GitHub Secrets 에만 넣는다.

#### `claude` 명령을 못 찾는다고 나오면 (윈도우에서 자주 난다)

설치는 됐는데 터미널이 아직 모르는 상태다. 순서대로 해보면 거의 다 풀린다.

**1) 터미널을 껐다 켠다.** PATH 는 터미널을 열 때 읽어들이므로, 설치 후 열려 있던 창은 새 명령을 모른다. 이것만으로 대부분 해결된다.

**2) 그래도 안 되면 설치 위치를 직접 확인한다.**

```bash
npm config get prefix
```

나온 경로 뒤에 `\claude.cmd` 를 붙인 게 실제 파일이다. 그 전체 경로로 바로 실행한다.

```bash
"C:\Users\내이름\AppData\Roaming\npm\claude.cmd" setup-token
```

**3) 관리자 권한이 필요하다고 하면** 터미널을 관리자로 실행해 `npm install -g` 를 다시 돌린다.

> 이 단계에서 시간을 많이 뺏기면 **구독 대신 API 키(②번)로 넘어가도 된다.** 하루 1편이면 월 1달러 안쪽이라, 여기서 한 시간 붙잡고 있는 것보다 나을 수 있다. 나중에 여유 있을 때 구독 방식으로 바꾸면 된다.

### ② 구독이 없다면 — API 키

1. https://console.anthropic.com 접속 → 가입
2. **API keys** → **Create Key**
3. `sk-ant-...` 복사 → **`ANTHROPIC_API_KEY`**
4. **Billing** 에서 결제수단 등록 (최소 $5부터)

하루 1편이면 월 1달러 안쪽, 하루 6편이라도 월 3~5달러 수준이다.
**Billing → Usage limits** 에서 월 한도를 걸어두면 마음이 편하다.

> 둘 다 등록하면 **구독 쪽이 우선** 쓰인다 (요금이 안 나가는 쪽).
> 어느 쪽으로 돌고 있는지는 `node scripts/doctor.mjs` 가 알려준다.

---

## 4단계 — 인스타그램 API (20~40분)

여기가 제일 오래 걸린다. 천천히 하면 된다.

### 4-1. 계정을 프로페셔널로 바꾸기

인스타 앱 → 프로필 → 메뉴 → **설정** → **계정 유형 및 도구** → **프로페셔널 계정으로 전환**
비즈니스든 크리에이터든 상관없다.

### 4-2. Meta 앱 만들기

1. https://developers.facebook.com → 우상단 **시작하기** 로 개발자 등록
2. **내 앱** → **앱 만들기**
3. 앱 용도: **기타** → 앱 유형: **비즈니스**
4. 앱 이름 입력 후 생성

> **개발자 등록이 안 넘어간다면** 본인 확인이 안 끝난 것이다. 페이스북 계정에 **휴대폰 번호와 이메일 인증**이 둘 다 돼 있어야 한다. 만든 지 얼마 안 된 계정이면 며칠 지나야 풀리기도 한다. 사업자 등록은 필요 없다.

> **"사용 사례를 고르세요" 화면이 나오면** — 이 자동화에 필요한 건 **Instagram 관련 사용 사례**다. 여러 개 골라도 되고, 나중에 앱 대시보드에서 바꿀 수 있으니 여기서 오래 고민하지 않아도 된다.

### 4-3. Instagram 제품 추가

1. 앱 대시보드 → **제품 추가** → **Instagram** → **설정**
2. **Instagram API 설정(Instagram 로그인 사용)** 을 선택한다
   - 이 방식은 페이스북 페이지 연결이 필요 없다
   - 이미 페북 페이지가 연결돼 있다면 기존 방식도 되지만, 이쪽이 단계가 적다
3. **계정 추가** 로 본인 인스타 프로 계정을 연결한다

### 4-4. 권한과 토큰

필요한 권한 두 가지:

- `instagram_business_basic`
- `instagram_business_content_publish`

1. **Instagram → API 설정** 화면에서 **액세스 토큰 생성**
2. 인스타 계정으로 로그인 → 권한 승인
3. 나온 토큰 → `.env` 의 **`IG_ACCESS_TOKEN`**

### 여기서 제일 많이 막힌다 — 두 가지

**① 계정을 추가하려는데 오류가 뜨거나, 로그인 창이 튕긴다**

개발 모드에서는 **앱에 역할로 등록된 계정만** 인증할 수 있다. 내 계정이라도 등록을 안 하면 막힌다.

1. 앱 대시보드 왼쪽 메뉴 → **앱 역할(App roles)** → **역할(Roles)**
2. 오른쪽 위 **사용자 추가(Add People)**
3. 뜨는 창에서 아래로 내려 **Instagram 테스터(Instagram Tester)** 를 고른다
4. 본인 인스타 **사용자 이름**을 넣고 초대를 보낸다

**그리고 초대를 수락해야 한다.** 이걸 빼먹어서 계속 막히는 경우가 많다.

> 인스타 앱 → 설정 → **앱 및 웹사이트** → **테스터 초대** → 수락

수락한 뒤 다시 **액세스 토큰 생성**을 하면 통과한다.

**② `instagram_business_content_publish` 가 목록에 없거나 추가가 안 된다**

권한 목록은 **어떤 사용 사례를 골랐는지**에 따라 달라진다. 이 권한이 안 보이면 Instagram 사용 사례가 앱에 안 붙어 있는 것이다.

1. 앱 대시보드 → **사용 사례(Use cases)** 로 가서 Instagram 관련 사용 사례를 추가한다
2. 그 사용 사례의 **사용자 지정(Customize)** 안에 권한 목록이 있다
3. 거기서 `instagram_business_basic` 과 `instagram_business_content_publish` 를 추가한다

권한을 추가한 뒤에는 **토큰을 다시 발급해야 한다.** 기존 토큰에는 새 권한이 들어 있지 않아서, 발행 단계에서야 권한 오류가 난다. 잘 붙었는지는 아래로 확인한다.

```bash
node scripts/instagram-setup.mjs
```

계정 ID 는 직접 찾을 필요가 없다. 토큰만 넣고 실행하면 된다.

```bash
node scripts/instagram-setup.mjs
```

연동 방식(Instagram 로그인 / 페이스북 페이지)을 자동으로 판별해 올바른 계정 ID 를 찾아 `.env` 에 채우고, 발행 권한이 실제로 붙어 있는지까지 확인해 준다.

> 인스타는 계정 ID 가 여러 종류라 화면에 보이는 숫자를 그냥 넣으면 발행 단계에서 권한 오류가 난다. 원인을 찾기 어려운 종류의 오류라 이 스크립트로 처리하는 게 안전하다.

### ⚠️ 토큰 만료 — 꼭 알아두기

**장기 토큰의 수명은 60일이다.** 만료되면 발행이 멈춘다.

- 만료가 가까워지면 자동화가 텔레그램으로 경고를 보낸다
- 갱신은 아래 한 줄이면 된다. 나온 새 토큰을 GitHub Secrets 의 `IG_ACCESS_TOKEN` 에 덮어쓰면 끝이다

```bash
node scripts/refresh-token.mjs
```

> 캘린더에 **50일 뒤 반복 일정**으로 걸어두는 걸 권한다.

### 개발 모드 그대로 써도 되나?

**본인 계정에만 올린다면 앱 심사 없이 그대로 쓸 수 있다.** 개발 모드에서 앱에 등록된 계정은 제한 없이 동작한다.

다른 사람 계정에 대신 올려주는 서비스를 하려면 그때 `instagram_business_content_publish` 권한 심사를 받으면 된다(2~4주 소요).

---

## 5단계 — 설정 (1분)

**Claude Code 에게 맡기는 게 가장 빠르다.** "자동 모드 세팅해줘" 라고 하면 필요한 값만 묻고 대신 실행한다.

직접 하고 싶다면 스킬 폴더에서:

```bash
npm install
node scripts/setup.mjs
```

분야·디자인·시간을 하나씩 묻는다. 값을 이미 알고 있다면 한 줄로 끝내도 된다.

```bash
node scripts/setup.mjs --repo owner/repo --handle @my_account \
  --brand-label "최신 AI 뉴스" --times "08:00,19:00"
```

`--repo` 만 필수고, 클론한 레포 안에서 돌리면 `git origin` 에서 알아서 찾으므로 그마저 생략된다. 전체 목록은 `node scripts/setup.mjs --help`.

끝나면 두 파일이 생긴다. **화면에 찍히는 실제 경로를 확인하자.**

- `<스킬폴더>/config/config.json` — 설정 (비밀값 없음)
- `<레포루트>/.github/workflows/cardnews.yml` — 스케줄 (현지 시각을 UTC 로 변환해 넣어준다)

> 워크플로는 반드시 **레포 루트의** `.github/workflows/` 에 있어야 GitHub 이 인식한다. 마법사가 `.git` 을 찾아 올라가 그 자리에 만들어 주지만, 스킬을 git 레포 밖(예: `~/.claude/skills/`)에 두면 만들 곳을 알 수 없어 임시 폴더에 만들고 경고한다. 그럴 땐 두 파일을 레포 루트로 직접 옮긴다.

---

## 6단계 — Secrets 등록 (5분)

GitHub 레포 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

다섯 개를 하나씩 등록한다.

| 이름 | 값 |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` **또는** `ANTHROPIC_API_KEY` | 3단계에서 고른 쪽 하나만 |
| `TELEGRAM_BOT_TOKEN` | 2단계 봇 토큰 |
| `TELEGRAM_CHAT_ID` | 2단계 채팅 ID |
| `IG_USER_ID` | 4단계 인스타 계정 ID |
| `IG_ACCESS_TOKEN` | 4단계 액세스 토큰 |

> `GITHUB_TOKEN` 은 등록하지 않는다. Actions 가 자동으로 넣어준다.

마지막으로 설정 파일과 워크플로를 push 한다.

```bash
git add .
git commit -m "설정 추가"
git push
```

---

## 7단계 — 시험 실행

1. 레포 → **Actions** 탭
2. 왼쪽에서 **cardnews** 선택
3. **Run workflow** → **Run workflow**
4. 2~3분 뒤 텔레그램으로 카드 이미지와 **[✅ 발행] [🗑 취소]** 버튼이 온다
5. 발행을 누르면 인스타에 올라간다

여기까지 되면 끝이다. 이후로는 매일 정한 시각에 알아서 온다.

### 발행하지 않고 확인만 하고 싶다면

```bash
node scripts/tick.mjs --dry
```

텔레그램까지만 보내고 멈춘다.

---

## 동작 방식

워크플로가 두 개다. 하나는 초안을 만들고, 하나는 **늦게 누른 발행 버튼**을 처리한다.

```
① cardnews.yml — 설정한 시각마다 (예: 08:00, 19:00)
   │
   ├─ 뉴스 수집        Google News RSS + 매체 RSS
   ├─ 카피 작성        Claude 구독 또는 API
   ├─ 카드 렌더        HTML → JPEG 1080×1350
   ├─ 이미지 업로드    레포에 커밋 → 공개 raw 주소 확보
   ├─ 텔레그램 전송    미리보기 + 발행 버튼
   ├─ 대기 등록        state/pending.json 에 초안 저장
   │
   └─ 처음 30분은 이 잡이 직접 대기
         ├─ 발행 → 즉시 인스타 업로드
         ├─ 취소 → 대기 목록에서 제거
         └─ 무응답 → 그냥 종료 (버튼은 살아 있음)

② cardnews-drain.yml — 15분마다
   │
   └─ 대기 중인 초안이 있으면 텔레그램 응답 확인
         ├─ 눌렸으면 → 인스타 업로드
         └─ 24시간 지난 초안 → 자동 만료
```

**발행 버튼은 계속 살아 있다.** 아침에 온 초안을 점심에 눌러도, 자기 전에 눌러도 올라간다. 늦어도 15분 안에 처리된다. 하루가 지난 초안은 뉴스가 상해서 자동으로 만료된다.

**같은 사건을 두 번 만들지 않는다.** 초안으로 만든 뉴스의 지문을 `state/published.json` 에 남기므로, 하루 여러 편을 내도 매번 다른 소식이 나온다.

**멈출 때는 알려준다.** Claude 토큰이 만료되거나 사용량 한도에 걸리면 텔레그램으로 원인과 해결 방법이 온다. 조용히 멈추는 일은 없다.

## 자주 바꾸는 설정

`config/config.json` 을 고치고 push 하면 다음 실행부터 반영된다.

| 항목 | 설명 |
|---|---|
| `publishTimes` | 초안 받는 시각 목록. **개수가 곧 하루 발행 편수**다. `["08:00","19:00"]` 이면 하루 2편. **바꾸면 `setup.mjs` 를 다시 돌려야** 워크플로 cron 도 같이 갱신된다 |
| `approvalMinutes` | 초안 잡이 직접 기다리는 시간. 이 시간이 지나도 버튼은 살아 있다 |
| `drainWatchMinutes` | 회수 잡이 한 번 뜰 때 버튼을 지켜보는 시간 (기본 110분). 바꾸면 워크플로의 `--minutes` 와 `timeout-minutes` 도 같이 맞춰야 한다. **예약 주기(2시간)보다 짧게 유지한다** — 길면 실행이 대기열에 쌓여 `cancelled` 로 남는다 |
| `pendingExpiryHours` | 이 시간이 지난 초안은 만료 (기본 24) |
| `autoPublish` | `true` 로 두면 승인 없이 바로 올린다. 처음엔 `false` 를 권한다 |
| `cards.count` | 본문 카드 장수 |
| `cards.template` | 디자인 |
| `topic.*` | 분야·키워드·수집 범위 |
| `brand.*` | 핸들·강조색·배지 문구 |

### 발행을 잠시 멈추고 싶다면

레포 → **Actions** → 왼쪽에서 **cardnews** → 우측 **`···`** → **Disable workflow**. 다시 켜면 그날부터 재개된다. 회수 잡(`cardnews-drain`)은 켜 두어도 대기 초안이 없으면 아무 일도 하지 않는다.
