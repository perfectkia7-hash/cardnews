# 문제 해결

막혔을 때 **가장 먼저** 이걸 돌린다. 무엇이 빠졌는지 한 번에 알려준다.

```bash
node scripts/doctor.mjs
```

---

## 생성 모드

### `크롬 계열 브라우저를 찾지 못했습니다`
카드 이미지를 만들려면 크롬이나 엣지가 필요하다. 윈도우는 엣지가 기본 탑재라 보통 자동으로 잡힌다.

크롬을 설치하거나, 경로를 직접 지정한다.

```bash
# Windows (PowerShell)
$env:PUPPETEER_EXECUTABLE_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"

# mac / Linux
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome
```

### 기사가 0건으로 나온다
1. `--hours` 를 48이나 72로 늘린다
2. 키워드를 넓힌다 — `"AI 반도체 공급망"` 처럼 좁으면 안 잡힌다. `"AI OR 반도체"` 로
3. `--lang` / `--region` 이 맞는지 본다. 해외 뉴스인데 `--lang ko` 면 거의 안 나온다
4. `--exclude` 가 너무 많은 걸 걸러내고 있진 않은지 본다

### 카드에 사진이 안 붙는다
가장 흔한 원인은 **구글 뉴스만 썼을 때**다. 구글 뉴스 링크는 JS 리다이렉트라 대표 이미지를 못 읽는다.

1. `--preset tech` 처럼 **실제 매체 RSS** 를 포함시킨다
2. `--full` 을 반드시 붙인다 (이걸 빼면 사진 추출을 안 한다)
3. `--prefer-images` 로 사진 있는 기사를 앞으로 올린다
4. `news.json` 을 열어 `image` 값이 채워졌는지 확인한다

렌더 로그에 `이미지 3/5장 확보` 처럼 나온다. 못 받은 건 매체가 핫링크를 막았거나 이미지가 너무 작은(12KB 미만, 로고로 판단) 경우다.

사진이 정 안 나오는 주제라면 타이포 템플릿으로 바꾼다.

```bash
node scripts/render.mjs --draft out/draft.json --template minimal --out out/cards
```

### 사진이 헤드라인과 안 맞는다
기사 대표 이미지를 그대로 쓰기 때문에, 매체가 일반적인 이미지(로고, 자료사진)를 걸어둔 경우 생긴다. `draft.json` 에서 그 카드의 `image` 를 다른 기사 사진으로 바꾸거나, 카드 자체를 교체한다.

### 글자가 잘리거나 넘친다
렌더러가 자동으로 줄여주지만 한계가 있다. `references/copywriting.md` 의 글자 수 표대로 카피를 줄인다. 특히 `headline` 한 줄 13자, `body` 140자를 넘기지 않는다.

### 한글이 네모(□)로 나온다
한글 폰트가 없는 환경이다. CDN 접근이 막혔거나 리눅스에 CJK 폰트가 없을 때 생긴다.

```bash
sudo apt-get install -y fonts-noto-cjk
```

### 카드 수가 예상과 다르다
표지 1장 + 본문 N장 + 엔딩 1장으로 나온다. `draft.json` 의 `cards` 에는 **본문만** 넣는다. 총 10장을 넘으면 잘린다.

---

## 자동 모드

### 텔레그램으로 아무것도 안 온다
1. 봇에게 **먼저 말을 걸었는지** 확인한다. 대화를 시작하지 않은 봇은 메시지를 못 보낸다
2. `TELEGRAM_CHAT_ID` 가 봇 ID 가 아니라 **내 채팅 ID** 인지 확인한다
3. Actions 탭에서 실행 로그를 본다 — 어느 단계에서 멈췄는지 나온다

### 발행 버튼을 눌러도 반응이 없다
초안 잡이 끝난 뒤에 눌렀다면 **회수 잡**(`cardnews-drain`)이 처리한다. 기본 15분 주기라 조금 기다리면 올라간다. 그래도 안 되면:

1. 레포 → **Actions** → **cardnews-drain** 이 켜져 있는지 확인한다 (Disable 돼 있으면 Enable)
2. **Run workflow** 로 수동 실행해 본다
3. 실행 로그에서 `대기 중인 초안 N건` 이 보이는지 확인한다. `0건` 이면 초안이 만료됐거나(24시간) 이미 처리된 것이다

**공개 레포가 60일간 커밋이 없으면 스케줄이 자동 정지된다.** 매일 이미지를 커밋하므로 보통 문제되지 않지만, 한동안 쉬었다면 Actions 탭에서 다시 켜야 한다.

### 같은 뉴스가 반복해서 온다
`state/published.json` 에 다룬 사건의 지문이 쌓이고, 다음 회차는 거기 없는 사건만 고른다. 그래도 반복된다면:

- 그 파일이 레포에 커밋되고 있는지 확인한다 (`imageHost` 가 `github` 이어야 한다. `telegram` 이면 상태가 남지 않는다)
- 워크플로의 `permissions: contents: write` 가 있는지 확인한다

일부러 초기화하려면 레포에서 `state/published.json` 을 지우면 된다.

### `인스타 API 오류 ... (#200)` 권한 부족
`instagram_business_content_publish` 권한이 승인되지 않았다. Meta 앱 → Instagram → API 설정에서 권한을 확인하고 토큰을 다시 발급받는다.

### `인스타 API 오류 ... OAuthException` / 토큰 만료
장기 토큰은 60일이면 끝난다.

```bash
node scripts/refresh-token.mjs
```

나온 값을 Secrets 의 `IG_ACCESS_TOKEN` 에 덮어쓴다. 이미 만료됐다면 Meta 앱에서 새로 발급받아야 한다.

### `The image URL is not accessible` / 이미지를 못 읽는다
1. 이미지 레포가 **Public** 인지 확인한다. Private 이면 인스타가 못 읽는다
2. `config.json` 의 `imageRepo` 가 `owner/repo` 형식인지 확인한다
3. `imageBranch` 가 실제 기본 브랜치와 같은지 확인한다 (`main` vs `master`)

### Actions 가 정해진 시간에 안 돈다
- GitHub 크론은 **UTC 기준**이다. `setup.mjs` 가 변환해 넣지만, `publishAt` 만 바꾸고 워크플로를 안 고치면 어긋난다. `setup.mjs` 를 다시 돌리는 게 안전하다
- GitHub 크론은 부하에 따라 **5~15분 늦게** 시작될 수 있다. 정상이다
- **공개 레포가 60일간 커밋이 없으면 스케줄이 자동 정지된다.** 매일 이미지를 커밋하므로 보통 문제되지 않는다

### Actions 실행 시간이 부족하다
공개 레포는 무제한 무료다. **Private 레포로 만들었다면** 발행 대기 30분이 매일 쌓여 무료 한도(월 2,000분)를 넘는다. 공개로 바꾸거나 `approvalMinutes` 를 5분 이하로 줄인다.

### Claude API 비용이 걱정된다
**Claude 구독(Pro/Max/Team/Enterprise)이 있으면 API 요금을 아예 안 내도 된다.**

```bash
npm install -g @anthropic-ai/claude-code
claude setup-token
```

나온 토큰을 Secrets 의 `CLAUDE_CODE_OAUTH_TOKEN` 에 등록하면 구독으로 실행된다. `ANTHROPIC_API_KEY` 는 지워도 된다 (둘 다 있으면 구독 쪽이 우선).

구독이 없다면 console.anthropic.com → **Billing → Usage limits** 에서 월 한도를 건다. 하루 1편이면 월 1달러 안쪽이다. 더 아끼려면 워크플로 env 에 모델을 추가한다.

```yaml
ANTHROPIC_MODEL: claude-haiku-4-5
```

### `Claude Code CLI 를 찾지 못했습니다`
구독 방식은 Claude Code CLI 로 실행된다. 워크플로가 자동으로 설치하지만, 로컬에서 돌릴 땐 직접 깔아야 한다.

```bash
npm install -g @anthropic-ai/claude-code
```

### `Claude CLI 오류 ... 인증`
토큰이 만료됐거나(유효기간 1년) 잘못 복사된 경우다. 다시 발급한다.

```bash
claude setup-token
```

---

## 그 밖에

### 게시물에 음악을 넣고 싶다
**인스타 API 로는 안 된다.** 음악 추가는 인스타 앱 전용 기능이라, 웹 업로더에도 없고 공식 API 에도 없다. 어떤 예약 발행 서비스를 써도 마찬가지다.

그래서 이 스킬은 발행이 끝나면 텔레그램으로 방법을 알려 준다.

```
인스타 앱 → 방금 올라온 게시물 → ⋯ → 수정 → 음악 추가
```

목록 맨 위가 지금 인기 있는 오디오다. 릴스가 아닌 일반 게시물도 2026년 기준 발행 뒤에 오디오를 붙이거나 바꿀 수 있다. 안내가 필요 없으면 `config.json` 에서 끈다.

```json
"music": { "remind": false }
```

> 트렌드 음원을 영상에 직접 입혀 올리는 방식은 권하지 않는다. 인스타의 음원 라이선스는 앱에서 고를 때만 적용되므로, 파일에 음원을 박아 올리면 음소거되거나 게시물이 내려간다.

### 시간이 지난 뒤 발행 버튼을 눌러도 반응이 없다
버튼의 로딩 표시가 멈추지 않고 발행도 안 되던 문제는 고쳤다 (텔레그램 콜백 ID 는 몇 분이면 만료되는데, 그 만료 오류가 회수 잡 전체를 멈추게 했다).

지금은 회수 잡이 도는 **최대 15분 안에** 올라간다. 버튼의 로딩 표시는 몇 초 뒤 저절로 사라지는 게 정상이고, 결과는 그 메시지가 `⏳ 발행 중…` → `✅ 발행 완료` 로 바뀌면서 알려 준다. 24시간이 지난 초안은 뉴스가 상해서 만료되며 `⏳ 만료됨` 으로 표시된다.

### 하루에 몇 번까지 올릴 수 있나
인스타 API 는 24시간 기준 **100건**까지 허용한다. 캐러셀 한 세트는 1건으로 센다.

### 이미지 레포가 계속 커진다
매일 카드 6장(약 1~2MB)이 쌓인다. 1년이면 500MB 안쪽이다. 신경 쓰이면 오래된 `cards/` 폴더를 가끔 지운다.

### 다른 계정을 하나 더 돌리고 싶다
레포를 하나 더 만들어 같은 방식으로 세팅한다. 설정과 Secrets 가 레포 단위라 서로 간섭하지 않는다.
