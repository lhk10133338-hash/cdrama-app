# CDRAMA — 중국 드라마 모바일 웹앱 (PWA)

iQIYI 스타일의 다크 테마로 만든 중국 드라마 시청 앱입니다. YouTube 공식 채널
(iQIYI Korea · WeTV Korea · YOUKU Korea)의 재생목록을 매일 자동으로 수집해
**한국어 제목·줄거리·회차 목록**을 보여주고, YouTube IFrame 플레이어로
**한국어 자막을 기본 켜진 상태**로 재생합니다.

## 구성

```
cdrama-app/
├── index.html                 # 앱 셸
├── css/style.css              # 다크 테마 + iQIYI 스타일 UI
├── js/app.js                  # 라우터 · 화면 · 플레이어 · localStorage
├── manifest.json              # PWA 매니페스트(홈 화면 추가)
├── sw.js                      # 서비스 워커(앱 셸 + 데이터 캐시)
├── icons/                     # 앱 아이콘(SVG/PNG/maskable)
├── data/
│   ├── dramas.json            # 수집 결과(앱이 읽는 데이터)
│   └── probe_cache.json       # 자막/임베드 검증 캐시
├── scripts/fetch_dramas.py    # 수집 스크립트(표준 라이브러리만 사용)
├── tools/smoke_test.py        # 화면 렌더링 스모크 테스트(개발용)
└── .github/workflows/update.yml  # 매일 자동 갱신 + 수동 실행
```

## 기능

- **홈**: 추천 배너 캐러셀(자동 넘김·스와이프), 계속 시청하기, 최신 업데이트,
  한국어 자막 추천, 정주행 추천, 장르별·플랫폼별 가로 스크롤 목록
- **탐색**: 장르·채널 필터 + 실시간 제목 검색
- **상세**: 배경 이미지, 줄거리 접기/펼치기, 찜하기, 회차 그리드(시청 완료 표시)
- **재생**: YouTube IFrame API(`cc_load_policy=1`, `cc_lang_pref=ko`, `hl=ko`,
  `playsinline=1`), 이전/다음 화, 다음 화 플로팅 버튼, 자동 진행 저장
- **보관함**: 이어보기 목록, 찜한 작품, 시청 완료 작품
- **PWA**: 안드로이드 크롬에서 "홈 화면에 추가"하면 전체 화면 앱처럼 실행,
  오프라인에서도 앱 셸과 마지막 데이터가 열립니다.

## 데이터 수집

```bash
python scripts/fetch_dramas.py                       # 전체 수집 + 검증
python scripts/fetch_dramas.py --no-probe            # 재생목록만 빠르게
python scripts/fetch_dramas.py --max-dramas 20 -v    # 소량 테스트
python scripts/fetch_dramas.py --include-overseas    # 중화권 채널까지 포함
```

동작 순서:

1. `/@채널/playlists` 의 `ytInitialData` 를 파싱(continuation으로 다음 페이지까지)
2. 하이라이트·예고·쇼츠·리얼리티 위주 재생목록 제외
3. 재생목록 안에서 **실제 회차**(`제N화` / `第N集` / `EP N` / `FULL 01`)만 추려
   회차 번호순 정리(8분 미만 클립 제외)
4. 대표 영상의 `ytInitialPlayerResponse` 로 **한국어 자막(ko) 트랙**과
   **`playableInEmbed`** 확인 → 막히면 임베디드 클라이언트 → transcript 패널 →
   oEmbed 순으로 보조 판정
5. 영상 설명에서 줄거리만 남기고, 제목·장르·플랫폼을 정리해 `data/dramas.json` 저장

### 지역 제한 주의

`@iqiyiofficial`, `@MangoTVDramaOfficial`, `@TencentVideo` 같은 중화권 채널은
한국에서 **지역 제한** 또는 **멤버십 전용**이라 재생되지 않는 경우가 많아
기본 수집 대상에서 제외했습니다(필요하면 `--include-overseas`).

## GitHub Pages 배포

1. 이 폴더(`cdrama-app`)를 저장소 루트로 올립니다.
2. 저장소 **Settings → Pages → Source: Deploy from a branch → `main` / root**.
3. `https://<사용자>.github.io/<저장소>/` 로 접속 → 크롬 메뉴 → **홈 화면에 추가**.

> 저장소 Settings → Actions → General → Workflow permissions 에서
> **Read and write permissions** 를 켜야 자동 커밋이 동작합니다.

## 자동 갱신

`.github/workflows/update.yml` 이 매일 05:17 KST(20:17 UTC)에
`scripts/fetch_dramas.py` 를 실행하고, `data/dramas.json` 이 바뀌면 자동 커밋합니다.
Actions 탭에서 **Run workflow** 로 즉시 실행할 수도 있습니다.

## 스모크 테스트

```bash
python tools/smoke_test.py     # quickjs로 app.js를 실행해 5개 화면 렌더 확인
```
