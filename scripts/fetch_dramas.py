#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""중드(중국 드라마) 카탈로그 수집기.

유튜브 공식 채널의 /playlists 페이지에서 ``ytInitialData`` 를 파싱해
드라마 재생목록(Full Episode)을 모으고, 대표 영상의 플레이어 응답에서
한국어 자막(ko) 트랙과 외부 임베드 가능 여부를 확인해 ``data/dramas.json``
을 만든다.

표준 라이브러리만 사용한다(설치 단계 없이 GitHub Actions에서 바로 실행).
실행 예:
    python scripts/fetch_dramas.py                 # 전체 수집 + 검증
    python scripts/fetch_dramas.py --no-probe      # 재생목록만 빠르게 수집
    python scripts/fetch_dramas.py --max-dramas 20 --verbose
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "https://www.youtube.com"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
HEADERS = {
    "User-Agent": UA,
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.7",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

# --------------------------------------------------------------------------
# 채널 설정
#   key     : 데이터 안에서 쓰는 채널 식별자
#   korean  : 한국어 자막/한국어 제목을 제공하는 채널(가산점)
# --------------------------------------------------------------------------
CHANNELS = [
    # 한국에서 바로 재생되고 한국어 자막을 제공하는 채널(기본 수집 대상)
    {"key": "youku-korea", "handle": "@YOUKUKorea", "name": "YOUKU Korea", "korean": True, "region": "KR",
     "captionsKoDefault": True},
    {"key": "wetv-korea", "handle": "@WeTVKorea", "name": "WeTV Korea", "korean": True, "region": "KR",
     "captionsKoDefault": None},
    {"key": "iqiyi-korea", "handle": "@iQIYIKorea", "name": "iQIYI Korea", "korean": True, "region": "KR",
     "captionsKoDefault": True},
    # 중화권 채널: 한국에서는 지역 제한/멤버십 전용이라 기본값에서는 제외한다.
    {"key": "iqiyi", "handle": "@iqiyiofficial", "name": "iQIYI 爱奇艺", "korean": False, "region": "GLOBAL"},
    {"key": "tencent", "handle": "@TencentVideo", "name": "腾讯视频 Tencent Video", "korean": False, "region": "GLOBAL"},
    {"key": "mangotv", "handle": "@MangoTVDramaOfficial", "name": "MangoTV Drama", "korean": False, "region": "GLOBAL"},
    {"key": "huace", "handle": "@huace", "name": "China Huace TV", "korean": False, "region": "GLOBAL"},
    {"key": "youku", "handle": "@Youku", "name": "Youku", "korean": False, "region": "GLOBAL"},
]

# 재생목록 후보에서 제외할 표현(하이라이트/예고/쇼츠 등)
CLIP_WORDS = [
    # 한국어
    "하이라이트", "예고", "티저", "메이킹", "비하인드", "인터뷰", "리액션", "명장면",
    "몰아보기", "결말", "해설", "쇼츠", "숏폼", "숏드라마", "클립", "선공개", "특집",
    "무대인사", "제작발표", "ost", "뮤직비디오", "직캠", "커플", "케미", "레전드",
    "리얼리티쇼", "예능", "reality show", "variety", "综艺", "리얼리티",
    # 영어
    "highlight", "trailer", "teaser", "behind", "making", "interview", "reaction",
    "recap", "clip", "shorts", "preview", "bts", "press", "featurette", "ost", "mv",
    "special", "best scene", "compilation", "episode 0",
    # 중국어
    "预告", "花絮", "采访", "特辑", "高光", "精彩", "片段", "幕后", "抢先看", "主题曲",
    "发布会", "开机", "杀青", "独家", "直拍", "混剪", "剪辑", "速看", "解说", "盘点",
]

# 에피소드 번호 추출 패턴(앞에서부터 우선 적용)
EP_PATTERNS = [
    re.compile(r"제\s*(\d{1,3})\s*화"),
    re.compile(r"第\s*(\d{1,3})\s*[集话話]"),
    re.compile(r"(?:EP|Ep|ep)\s*\.?\s*(\d{1,3})"),
    # iQIYI 글로벌 채널의 'FULL 01 |' 형태(여러 화를 묶은 파트)
    re.compile(r"\bFULL\s*0*(\d{1,3})\b"),
    re.compile(r"\bPart\s*\.?\s*0*(\d{1,3})\b", re.I),
    re.compile(r"合集\s*0*(\d{1,3})"),
    re.compile(r"(?<![\dA-Za-z])(\d{1,3})\s*화"),
    re.compile(r"(?<![\dA-Za-z])E\s?(\d{1,3})(?![\d])"),
]
EP_RANGE_RE = re.compile(r"(\d{1,3})\s*[-~]\s*(\d{1,3})\s*화")
DURATION_RE = re.compile(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?$")

GENRE_RULES = [
    ("사극", [
        "사극", "시대극", "고장", "무협", "궁궐", "황후", "황제", "전하", "왕조", "조정",
        "대장군", "후궁", "장안", "세자", "무사", "검객", "선비", "과거시험", "개국",
        "江湖", "武侠", "仙侠", "古装", "皇帝", "宫", "王朝", "王爷", "将", "侠", "剑",
        "wuxia", "costume", "dynasty", "palace", "emperor", "empress", "sword", "blade",
        "ancient",
    ]),
    ("판타지", [
        "판타지", "마법", "요괴", "귀신", "초능력", "환생", "이세계", "선녀", "마존",
        "신선", "영혼", "수호신", "원혼",
        "奇幻", "仙侠", "妖", "魔尊", "灵异", "玄幻",
        "fantasy", "magic", "demon", "supernatural", "immortal", "soul",
    ]),
    ("미스터리", [
        "미스터리", "수사", "형사", "사건", "범죄", "추적", "스릴러", "서스펜스", "복수",
        "비밀", "살인", "음모", "경찰", "법의학", "실종",
        "悬疑", "刑侦", "案", "谜", "犯", "复仇", "凶",
        "mystery", "crime", "detective", "thriller", "suspense", "investigation",
        "revenge", "murder", "secret",
    ]),
    ("액션", [
        "액션", "전투", "격투", "무술", "특수부대", "작전", "전쟁", "무림",
        "action", "fight", "martial", "war", "battle", "combat",
    ]),
    ("로맨스", [
        "로맨스", "사랑", "애정", "연애", "설렘", "첫사랑", "계약결혼", "혼인", "결혼",
        "爱情", "恋", "romance", "love", "sweet", "marriage", "crush",
    ]),
    ("코미디", [
        "코미디", "개그", "웃음", "코믹", "喜剧", "搞笑",
        "comedy", "comic", "funny", "sitcom",
    ]),
    ("의학", [
        "의사", "병원", "의학", "수술", "의료", "법의학자", "medical", "doctor", "hospital",
    ]),
    ("법정", [
        "법정", "변호사", "판사", "검사", "재판", "legal", "lawyer", "court", "justice",
    ]),
    ("가족", [
        "가족", "엄마", "아빠", "가문", "세대", "家庭", "family",
    ]),
]
GENRE_ORDER = ["사극", "판타지", "미스터리", "액션", "로맨스", "코미디", "의학", "법정", "가족"]

# 손으로 지정하는 장르(자동 분류가 어긋나는 작품 보정). 재생목록 ID 기준.
GENRE_OVERRIDES = {
    "PLdmsjGa2G4ho": ["사극", "로맨스"],      # 절월량: 달을 만났을 때
    "PLdY9nlIbIf8Y": ["사극", "미스터리"],    # 매영신포 Shadow Punisher
    "PLNzu61vyy04k": ["사극", "액션"],        # 일구춘 Spring of The Blade
    "PLSkm7vpNKRbE": ["로맨스", "코미디"],    # 천재, 여우
    "PLN_jlGL5B4EM": ["사극", "판타지"],      # 작골 Key to the Phoenix Heart
    "PLKCiGEWuc4bI": ["현대극", "로맨스"],    # 저일초과화 OVERDO
    "PLZViDNJsEK5Y": ["사극", "로맨스"],      # 찬여번성 Road to Success
    "PLAdlvb-BeIp0": ["현대극", "로맨스"],    # 돈트 비 투 이모셔널
    "PLDm1tvW8dcS0": ["현대극", "로맨스"],    # 치하 Never-Ending Summer
    "PL2k3iGlQIRUizITfA6PCU8k-x-LvSDnNH": ["사극"],          # 운수행
    "PL2k3iGlQIRUhfmoohga_4_xJ2IirSX83O": ["미스터리", "사극"],  # 남부당안
    "PL2k3iGlQIRUj8ALBGZwJcvJRrr3gLZfm8": ["사극"],          # 가업
    "PL2k3iGlQIRUgz96ZgnJLPAo2OEY5OTOkT": ["사극", "로맨스"],   # 객십연가
    "PL2k3iGlQIRUhGTXy7wnPrD0qS5Ezfup85": ["사극", "로맨스"],   # 가우천성
    "PL2k3iGlQIRUjXWff3Fnkjh1lfElggxIG_": ["사극", "미스터리"],  # 축옥
    "PL2k3iGlQIRUgZeDtZa7uBEOoh-hRVeR_u": ["사극", "로맨스"],   # 성하체통
    "PL2k3iGlQIRUj77_6egKtaeQFCOrsEkTqK": ["현대극", "로맨스"], # 알희
    "PL2k3iGlQIRUi8268irrdi6sZ-IDj7qYOC": ["사극", "판타지"],   # 소요
    "PL2k3iGlQIRUi9fy5c_tUXrk_LHpykHT-e": ["사극", "미스터리", "판타지"],  # 당궤기담
    "PL2k3iGlQIRUhtr0KhTvPb3Ne7h5_ECD34": ["로맨스", "코미디"], # 태첨랍
    "PL2k3iGlQIRUiXJPvJCxe24ipExzO4LRvs": ["로맨스", "코미디"], # 스피드 & 러브
    "PL2k3iGlQIRUh3peN9tL4i6Q76SDQCIEu8": ["사극", "로맨스"],   # 풍여조
    "PL2k3iGlQIRUjsyZMDO-zxf-ft8rhl8v1m": ["사극", "로맨스"],   # 천금난도
    "PL2k3iGlQIRUhe4yKJLRIRxbgW86eDCUPM": ["현대극", "로맨스"], # 애정응해유적양자
    "PL2k3iGlQIRUghj4HzNvV_3lYpvRW-zfzy": ["현대극", "로맨스"], # 견면파취현재
    "PL2k3iGlQIRUiPYCDc0krtqtfPyRA-Vfp0": ["사극", "미스터리", "판타지"],  # 당조궤사록
    "PL2k3iGlQIRUjbUT5yqrGPu_FgzLT4jgJY": ["사극", "액션"],     # 천지검심
    "PL2k3iGlQIRUh9Ai_5VAAZd_yIgKB2OQXO": ["사극", "로맨스"],   # 일소수가
    "PL2k3iGlQIRUi4NXr1RIPp0MWH0E4ir82J": ["현대극", "미스터리"], # 불면일 MOBIUS
}

_LOCK = threading.Lock()
_REQUEST_COUNT = [0]

# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------


def http_get(url: str, retries: int = 3, timeout: int = 40) -> str:
    """GET 요청 후 문자열 반환(간단한 재시도 포함)."""
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            with _LOCK:
                _REQUEST_COUNT[0] += 1
            return raw.decode("utf-8", "replace")
        except urllib.error.HTTPError as err:
            last_err = err
            if err.code in (400, 401, 403, 404, 410):
                # 재시도해도 결과가 같을 가능성이 높다.
                raise
            time.sleep(2.0 * (attempt + 1))
        except Exception as err:  # noqa: BLE001 - 네트워크 예외 전반
            last_err = err
            time.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"request failed: {url} ({last_err})")


_JSON_DECODER = json.JSONDecoder()


def extract_json_var(html: str, var_name: str):
    """``var ytInitialData = {...};`` 형태의 JSON을 꺼낸다."""
    for needle in (f"var {var_name} = ", f"{var_name} = "):
        idx = html.find(needle)
        if idx >= 0:
            try:
                obj, _ = _JSON_DECODER.raw_decode(html[idx + len(needle):])
                return obj
            except ValueError:
                continue
    return None


def walk_key(obj, key):
    """중첩 구조에서 특정 키의 값을 모두 찾는다(깊이 우선)."""
    stack = [obj]
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            for k, v in cur.items():
                if k == key:
                    yield v
                if isinstance(v, (dict, list)):
                    stack.append(v)
        elif isinstance(cur, list):
            stack.extend(x for x in cur if isinstance(x, (dict, list)))


def find_continuation(obj, browse_only: bool = True):
    """다음 페이지 토큰 목록."""
    tokens = []
    for cc in walk_key(obj, "continuationCommand"):
        if not isinstance(cc, dict):
            continue
        token = cc.get("token")
        if not token:
            continue
        if browse_only and cc.get("request") not in ("CONTINUATION_REQUEST_TYPE_BROWSE", None):
            continue
        tokens.append(token)
    return tokens


def browse_continuation(token: str, ctx: dict) -> dict:
    """innertube browse API로 다음 페이지를 가져온다."""
    client = ctx.get("client", {})
    headers = {
        "User-Agent": UA,
        "Content-Type": "application/json",
        "Accept-Language": "ko-KR,ko;q=0.9",
        "Origin": BASE,
        "X-YouTube-Client-Name": "1",
        "X-YouTube-Client-Version": client.get("clientVersion", ""),
        "X-Goog-Visitor-Id": client.get("visitorData", ""),
    }
    body = json.dumps({"context": ctx, "continuation": token}).encode()
    req = urllib.request.Request(
        f"{BASE}/youtubei/v1/browse?prettyPrint=false", data=body, headers=headers
    )
    with urllib.request.urlopen(req, timeout=40) as resp:
        with _LOCK:
            _REQUEST_COUNT[0] += 1
        return json.loads(resp.read().decode("utf-8", "replace"))


def page_context(html: str) -> dict:
    """페이지의 방문자 정보로 innertube 컨텍스트를 만든다."""
    visitor = re.search(r'"VISITOR_DATA":"(.*?)"', html)
    cver = re.search(r'"INNERTUBE_CLIENT_VERSION":"(.*?)"', html)
    return {
        "client": {
            "clientName": "WEB",
            "clientVersion": cver.group(1) if cver else "2.20240101.00.00",
            "hl": "ko",
            "gl": "KR",
            "visitorData": visitor.group(1) if visitor else "",
        },
        "user": {"lockedSafetyMode": False},
    }


# --------------------------------------------------------------------------
# lockup(카드) 파싱
# --------------------------------------------------------------------------


def iter_lockups(data):
    for lv in walk_key(data, "lockupViewModel"):
        if isinstance(lv, dict) and lv.get("contentId"):
            yield lv


def lockup_title(lv: dict) -> str:
    meta = (lv.get("metadata") or {}).get("lockupMetadataViewModel") or {}
    title = meta.get("title") or {}
    return (title.get("content") or "").strip()


def lockup_sources(lv: dict):
    image = lv.get("contentImage") or {}
    collection = image.get("collectionThumbnailViewModel")
    if collection:
        image = ((collection.get("primaryThumbnail") or {}).get("thumbnailViewModel") or {}).get("image") or {}
    else:
        image = (image.get("thumbnailViewModel") or {}).get("image") or {}
    return image.get("sources") or []


def lockup_thumbnail(lv: dict) -> str:
    sources = lockup_sources(lv)
    if sources:
        return sources[-1].get("url", "")
    return ""


def lockup_badges(lv: dict):
    out = []
    for badge in walk_key(lv, "thumbnailBadgeViewModel"):
        if isinstance(badge, dict) and badge.get("text"):
            out.append(badge["text"])
    return out


def parse_duration_seconds(text: str) -> int:
    m = DURATION_RE.match((text or "").strip())
    if not m:
        return 0
    a, b, c = m.group(1), m.group(2), m.group(3)
    if c is not None:
        return int(a) * 3600 + int(b) * 60 + int(c)
    return int(a) * 60 + int(b)


def parse_int(text: str) -> int:
    digits = re.sub(r"[^\d]", "", text or "")
    return int(digits) if digits else 0


REL_DATE_RE = re.compile(r"(\d+)\s*(초|분|시간|일|주|개월|년|month|week|day|hour|minute)\s*전")
_REL_UNITS = {"초": 1, "분": 60, "시간": 3600, "일": 86400, "주": 604800, "개월": 2592000,
              "년": 31536000, "minute": 60, "hour": 3600, "day": 86400, "week": 604800, "month": 2592000}


def parse_relative_ago(text: str):
    """'2일 전' → 초 단위 경과 시간(없으면 None)."""
    if not text:
        return None
    m = REL_DATE_RE.search(text)
    if m:
        return int(m.group(1)) * _REL_UNITS.get(m.group(2), 0)
    if "방금" in text or "just now" in text.lower():
        return 0
    return None


# --------------------------------------------------------------------------
# 채널 → 재생목록
# --------------------------------------------------------------------------


def fetch_channel_playlists(channel: dict, max_pages: int = 4, verbose: bool = False):
    url = f"{BASE}/{channel['handle']}/playlists?hl=ko&gl=KR"
    html = http_get(url)
    data = extract_json_var(html, "ytInitialData")
    if not data:
        if verbose:
            print(f"  ! {channel['handle']}: ytInitialData 없음", file=sys.stderr)
        return []

    ctx = page_context(html)
    pages = [data]
    queue = [t for t in find_continuation(data) if t]
    seen_tokens = set()
    for _ in range(max_pages - 1):
        token = next((t for t in queue if t not in seen_tokens), None)
        if not token:
            break
        seen_tokens.add(token)
        try:
            page = browse_continuation(token, ctx)
        except Exception as err:  # noqa: BLE001
            if verbose:
                print(f"  ! continuation 실패: {err}", file=sys.stderr)
            continue
        pages.append(page)
        queue.extend(t for t in find_continuation(page) if t not in seen_tokens)

    playlists = []
    seen = set()
    for page in pages:
        for lv in iter_lockups(page):
            if lv.get("contentType") != "LOCKUP_CONTENT_TYPE_PLAYLIST":
                continue
            pid = lv["contentId"]
            if pid in seen:
                continue
            seen.add(pid)
            badges = lockup_badges(lv)
            count = 0
            for b in badges:
                m = re.search(r"(\d[\d,]*)\s*(?:개|videos?)", b)
                if m:
                    count = parse_int(m.group(1))
                    break
            playlists.append(
                {
                    "playlistId": pid,
                    "title": lockup_title(lv),
                    "thumbnail": lockup_thumbnail(lv),
                    "videoCount": count,
                    "channelKey": channel["key"],
                    "channelName": channel["name"],
                    "channelHandle": channel["handle"],
                    "korean": channel["korean"],
                }
            )
    if verbose:
        print(f"  {channel['name']}: 재생목록 {len(playlists)}개", file=sys.stderr)
    return playlists


# --------------------------------------------------------------------------
# 재생목록 → 영상
# --------------------------------------------------------------------------


def fetch_playlist_videos(pid: str, max_pages: int = 3, verbose: bool = False) -> dict:
    url = f"{BASE}/playlist?list={pid}&hl=ko&gl=KR"
    html = http_get(url)
    data = extract_json_var(html, "ytInitialData")
    if not data:
        return {"title": "", "videos": [], "description": ""}

    meta = (data.get("metadata") or {}).get("playlistMetadataRenderer") or {}
    title = (meta.get("title") or "").strip()
    description = (meta.get("description") or "").strip()

    videos = []
    seen = set()

    def collect(page):
        for lv in iter_lockups(page):
            if lv.get("contentType") != "LOCKUP_CONTENT_TYPE_VIDEO":
                continue
            vid = lv["contentId"]
            if vid in seen:
                continue
            seen.add(vid)
            badges = lockup_badges(lv)
            dur_text = next((b for b in badges if DURATION_RE.match((b or "").strip())), "")
            meta_rows = (((lv.get("metadata") or {}).get("lockupMetadataViewModel") or {}).get("metadata") or {})
            parts_text = []
            for row in ((meta_rows.get("contentMetadataViewModel") or {}).get("metadataRows") or []):
                for part in row.get("metadataParts") or []:
                    value = ((part.get("text") or {}).get("content") or "").strip()
                    if value:
                        parts_text.append(value)
            published_text = next((t for t in parts_text if parse_relative_ago(t) is not None), "")
            videos.append(
                {
                    "videoId": vid,
                    "title": lockup_title(lv),
                    "durationText": dur_text,
                    "durationSec": parse_duration_seconds(dur_text),
                    "thumbnail": lockup_thumbnail(lv),
                    "publishedText": published_text,
                    "publishedAgo": parse_relative_ago(published_text),
                }
            )

    collect(data)
    ctx = page_context(html)
    queue = [t for t in find_continuation(data) if t]
    seen_tokens = set()
    for _ in range(max_pages - 1):
        token = next((t for t in queue if t not in seen_tokens), None)
        if not token:
            break
        seen_tokens.add(token)
        try:
            page = browse_continuation(token, ctx)
        except Exception:  # noqa: BLE001
            continue
        before = len(videos)
        collect(page)
        queue.extend(t for t in find_continuation(page) if t not in seen_tokens)
        if len(videos) == before:
            continue

    return {"title": title, "description": description, "videos": videos}


# --------------------------------------------------------------------------
# 제목 정리 / 회차 추출 / 장르
# --------------------------------------------------------------------------


def is_clip_title(title: str) -> bool:
    low = title.lower()
    if EP_RANGE_RE.search(title):
        return True
    return any(word in low for word in CLIP_WORDS)


def episode_number(title: str):
    for pattern in EP_PATTERNS:
        m = pattern.search(title)
        if m:
            n = int(m.group(1))
            if 1 <= n <= 150:
                return n
    return None


def clean_title(raw: str, channel_name: str = "") -> dict:
    """재생목록 제목을 '작품명 / 원제 / 영문명' 으로 나눈다."""
    text = raw
    # 이모지·특수문자 제거
    text = re.sub(r"[\U0001F000-\U0001FAFF\u2190-\u21FF\u2300-\u23FF\u25A0-\u27BF\u2B00-\u2BFF\uFE0F\u200D]+", " ", text)
    text = re.sub(r"[【】\[\]「」『』<>《》⌜⌟⌞⌝〔〕]", " ", text)
    text = re.sub(r"\s+", " ", text).strip(" |-–·•")

    # 채널 홍보용 접두어 반복 제거
    prefix_re = re.compile(
        r"^(?:get\s*app\s*now|download\s*app|member|members?\s*only|full\s*episodes?|full|"
        r"eng\s*sub|eng\s*dub|multi\s*sub|multi|on\s*air\s*now|sub|hd|4k|official|new|"
        r"episodes?|正片|会员专享版|会员播放列表|完整版|全集)\s*[:\-]?\s*",
        re.I,
    )
    for _ in range(5):
        new_text = prefix_re.sub("", text).strip(" |-–·•:")
        if new_text == text:
            break
        text = new_text

    parts = [p.strip() for p in re.split(r"\s*[|｜]\s*", text) if p.strip()]
    parts = [p for p in parts if channel_name.lower() not in p.lower()]
    parts = [p for p in parts if p.lower() not in ("get the iqiyi app", "iqiyi", "wetv", "we tv", "youku", "download now")]

    korean_parts, english_parts, chinese_parts = [], [], []
    for p in parts:
        if re.search(r"[가-힣]", p):
            korean_parts.append(p)
        elif re.search(r"[\u4e00-\u9fff]", p):
            if re.search(r"[A-Za-z]{2,}", p):
                english_parts.append(p)
            else:
                chinese_parts.append(p)
        elif re.search(r"[A-Za-z]{2,}", p):
            english_parts.append(p)

    if korean_parts:
        title = korean_parts[0]
    elif english_parts:
        title = english_parts[0]
    elif chinese_parts:
        title = chinese_parts[0]
    else:
        title = text

    # '——' 뒤 홍보 문구, 회원 전용 표기 등 제거
    title = re.split(r"\s*(?:——|--|ㅡㅡ)\s*", title)[0]
    title = re.sub(r"\s*(?:会员专享版|会员播放列表|会员|독점|단독|정식판|무삭제판|한국어 더빙)\s*", " ", title)
    # '제목 설명문...' 형태에서 앞의 짧은 제목만 취하기
    title = re.sub(r"\s*(?:,|，)\s*(?:주연|출연|감독|각본).*$", "", title)
    title = re.sub(r"\s*(?:풀버전|전체|모음|Full Episodes?|全\d+集)\s*$", "", title, flags=re.I)
    title = re.sub(r"\s+", " ", title).strip()
    tokens = title.split()
    if len(tokens) >= 2:
        head = tokens[0]
        rest = " ".join(tokens[1:])
        head_is_name = bool(re.search(r"[가-힣\u4e00-\u9fff]", head)) and not re.search(r"[A-Za-z]", head)
        sep = title[len(head):len(head) + 1]
        tail_particle = bool(re.search(r"[의에을를이가은는과와로도만]$", head))
        if head_is_name and 2 <= len(head) <= 14 and len(rest) >= 14 and not tail_particle \
                and sep not in (":", "："):
            title = head

    title = title.strip(" :|–-·•")
    if not title:
        title = (english_parts[0] if english_parts else text).strip() or "제목 미상"

    # 영문 + 중국어 원제 분리: 'The Great Long March 伟大的长征'
    title_zh = ""
    m = re.match(r"^(.*[A-Za-z]{2,})\s+([\u4e00-\u9fff·]{2,18})$", title)
    if m:
        title, title_zh = m.group(1).strip(), m.group(2)
    if not title_zh:
        m = re.match(r"^([\u4e00-\u9fff·]{2,18})\s+(.*[A-Za-z]{2,}.*)$", title)
        if m:
            title_zh, title = m.group(1), m.group(2).strip()
    if not title_zh and re.search(r"[\u4e00-\u9fff]", title):
        m = re.search(r"[\u4e00-\u9fff·]{2,18}", title)
        if m:
            title_zh = m.group(0)
    if not title_zh:
        for p in chinese_parts:
            if p != title:
                m = re.search(r"[\u4e00-\u9fff·]{2,18}", p)
                if m:
                    title_zh = m.group(0)
                    break

    title_en = ""
    for p in english_parts:
        if p == title or re.search(r"[가-힣]", p):
            continue
        m = re.search(r"[A-Za-z][A-Za-z0-9'’,:&!?\-]*(?:\s+[A-Za-z0-9'’,:&!?\-]+){1,6}", p)
        if m and len(m.group(0)) >= 4:
            title_en = m.group(0).strip(" ,-—")
            break

    return {"title": title, "titleEn": title_en, "titleZh": title_zh, "titleRaw": raw}


def detect_genres(text: str, playlist_id: str = ""):
    if playlist_id in GENRE_OVERRIDES:
        return list(GENRE_OVERRIDES[playlist_id])
    low = text.lower()
    hits = []
    for genre, words in GENRE_RULES:
        if any(w.lower() in low for w in words):
            hits.append(genre)
    if not hits:
        hits = ["현대극"]
    # 로맨스/사극을 앞세우고 최대 3개
    hits.sort(key=lambda g: GENRE_ORDER.index(g) if g in GENRE_ORDER else 99)
    return hits[:3]


def detect_modern(text: str, genres):
    """현대극 여부를 별도 플래그로 둔다(사극/판타지가 아닌 경우)."""
    if "사극" in genres or "판타지" in genres:
        return False
    return True


# --------------------------------------------------------------------------
# 한국어 자막 / 임베드 검증
# --------------------------------------------------------------------------


SYNOPSIS_MARKERS = ["【설명】", "설명:", "줄거리:", "줄거리", "시놉시스", "剧情简介", "简介", "剧情", "Synopsis", "Story:"]
PROMO_HINTS = ("http", "구독", "subscribe", "다운로드", "download", "앱에서", "app", "멤버십", "membership",
               "▶", "👉", "🔍", "★★", "#", "bit.ly", "iqi", "wetv", "youku", "s.iq.com", "qr.")


def clean_description(raw: str, limit: int = 320) -> str:
    """영상 설명에서 줄거리만 남긴다(링크·홍보 문구 제거)."""
    if not raw:
        return ""
    text = raw.replace("\r", "\n")
    lines = []
    for line in text.split("\n"):
        low = line.lower()
        if any(h in low for h in PROMO_HINTS) and len(line) < 200:
            continue
        lines.append(line.strip())
    body = "\n".join(l for l in lines if l)
    for marker in SYNOPSIS_MARKERS:
        idx = body.find(marker)
        if idx >= 0:
            body = body[idx + len(marker):]
            break
    body = re.sub(r"\[출연진\]|\[연출\]|\[출연\]|출연진:|연출:|출연:|Cast:|Starring:", " ", body)
    for cut_marker in ("Click here for more content", "【Trending】", "Trending", "• 【", "🔔", "👉", "▶"):
        idx = body.find(cut_marker)
        if idx > 20:
            body = body[:idx]
    body = re.sub(r"\s+", " ", body).strip(" -–·•|:【】")
    if len(body) <= 20:
        return ""
    if len(body) > limit:
        cut = body[:limit]
        for sep in (". ", "。", "!", "?", "다."):
            pos = cut.rfind(sep)
            if pos > limit * 0.6:
                cut = cut[: pos + len(sep)]
                break
        body = cut.strip()
    return body


def watch_meta(video_id: str, verbose: bool = False) -> dict:
    """시청 페이지에서 플레이어 응답·설명을 얻는다."""
    out = {"html": "", "player": None, "initial": None, "description": ""}
    try:
        html = http_get(f"{BASE}/watch?v={video_id}&hl=ko&gl=KR")
    except Exception as err:  # noqa: BLE001
        if verbose:
            print(f"    ! watch fetch 실패 {video_id}: {err}", file=sys.stderr)
        return out
    out["html"] = html
    out["player"] = extract_json_var(html, "ytInitialPlayerResponse")
    out["initial"] = extract_json_var(html, "ytInitialData")
    if out["initial"]:
        raw = ""
        for node in walk_key(out["initial"], "attributedDescription"):
            if isinstance(node, dict) and node.get("content"):
                raw = node["content"]
                break
        if not raw:
            for node in walk_key(out["initial"], "description"):
                if isinstance(node, dict) and node.get("content") and len(node["content"]) > 40:
                    raw = node["content"]
                    break
        out["description"] = clean_description(raw)
    return out


def _caption_languages(player_response: dict):
    captions = (player_response.get("captions") or {}).get("playerCaptionsTracklistRenderer") or {}
    langs = []
    for track in captions.get("captionTracks") or []:
        code = track.get("languageCode")
        if code:
            langs.append({"code": code, "kind": track.get("kind") or "", "name": track.get("name", {}).get("simpleText", "")})
    return langs


def probe_embed_client(video_id: str) -> dict:
    """임베디드 플레이어 클라이언트로 플레이어 응답을 요청한다.

    일부 네트워크에서는 일반 시청 페이지가 봇 차단되지만 이 경로는 통과한다.
    """
    body = {
        "context": {
            "client": {
                "clientName": "WEB_EMBEDDED_PLAYER",
                "clientVersion": "1.20240101.00.00",
                "hl": "ko",
                "gl": "KR",
                "thirdParty": {"embedUrl": "https://www.youtube.com/"},
            }
        },
        "videoId": video_id,
    }
    headers = {
        "User-Agent": UA,
        "Content-Type": "application/json",
        "Accept-Language": "ko-KR,ko;q=0.9",
        "Origin": "https://www.youtube.com",
    }
    req = urllib.request.Request(
        f"{BASE}/youtubei/v1/player?prettyPrint=false",
        data=json.dumps(body).encode(),
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        return {}


def probe_video(video_id: str, verbose: bool = False) -> dict:
    """대표 영상의 자막/임베드 가능 여부와 줄거리를 확인한다.

    1) 시청 페이지의 ``ytInitialPlayerResponse`` (가장 정확: ko 트랙 + playableInEmbed)
    2) 실패하면(로그인/봇 차단) transcript 패널 유무로 자막 존재 여부 추정
    3) 임베드는 oEmbed 응답으로 보조 확인
    """
    result = {
        "videoId": video_id,
        "captionsKo": None,
        "captionsAny": None,
        "embeddable": None,
        "method": "none",
        "languages": [],
        "description": "",
        "checkedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
    }

    meta = watch_meta(video_id, verbose=verbose)
    result["description"] = meta.get("description", "")

    player = meta.get("player")
    if player:
        status = (player.get("playabilityStatus") or {}).get("status")
        if status in ("OK", "PLAYABLE"):
            langs = _caption_languages(player)
            codes = {l["code"] for l in langs}
            result.update(
                captionsKo="ko" in codes,
                captionsAny=bool(codes),
                embeddable=bool((player.get("playabilityStatus") or {}).get("playableInEmbed", True)),
                method="player",
                languages=[l["code"] for l in langs],
            )
            return result
        result["playability"] = status

    # 1-b) 임베디드 클라이언트로 재시도 (막힌 네트워크 우회)
    if result["captionsKo"] is None:
        emb = probe_embed_client(video_id)
        if emb:
            status = (emb.get("playabilityStatus") or {}).get("status")
            if status in ("OK", "PLAYABLE"):
                langs = _caption_languages(emb)
                codes = {l["code"] for l in langs}
                result.update(
                    captionsKo="ko" in codes,
                    captionsAny=bool(codes),
                    embeddable=bool((emb.get("playabilityStatus") or {}).get("playableInEmbed", True)),
                    method="player-embed",
                    languages=[l["code"] for l in langs],
                )
                return result

    # 2) transcript 패널 = 자막(자동 생성 포함)이 존재
    initial = meta.get("initial")
    if initial and any(True for _ in walk_key(initial, "getTranscriptEndpoint")):
        result.update(captionsAny=True, method="transcript")

    # 3) oEmbed: 응답 코드는 참고용(임베드 차단 여부를 단독으로 확정하지 않는다)
    try:
        url = f"{BASE}/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
        with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=25) as resp:
            if resp.status == 200:
                data = json.loads(resp.read().decode("utf-8", "replace"))
                result["oembedAuthor"] = data.get("author_name", "")
                if result["method"] == "none":
                    result["method"] = "oembed"
    except urllib.error.HTTPError as err:
        if err.code in (401, 403, 404):
            result["embeddable"] = False
    except Exception:  # noqa: BLE001
        pass

    return result


def load_probe_cache(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_probe_cache(path: str, cache: dict) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(cache, fh, ensure_ascii=False, indent=1, sort_keys=True)


def cache_is_fresh(entry: dict, max_age_days: int) -> bool:
    # 시청 페이지가 막혀 확정하지 못한 결과(oembed/error)는 매 실행에서 다시 확인한다.
    if entry.get("method") in ("oembed", "error", "none", "skipped"):
        return False
    try:
        checked = dt.datetime.fromisoformat(entry.get("checkedAt", ""))
    except (TypeError, ValueError):
        return False
    if checked.tzinfo is None:
        checked = checked.replace(tzinfo=dt.timezone.utc)
    age = dt.datetime.now(dt.timezone.utc) - checked
    return age.days < max_age_days


# --------------------------------------------------------------------------
# 카탈로그 조립
# --------------------------------------------------------------------------


def episodes_from_videos(videos, max_episodes: int = 120):
    """영상 목록에서 '실제 회차'만 골라 번호순으로 정리."""
    by_number = {}
    for idx, video in enumerate(videos):
        title = video["title"]
        if is_clip_title(title):
            continue
        number = episode_number(title)
        if number is None:
            continue
        if video["durationSec"] and video["durationSec"] < 480:
            continue  # 8분 미만은 회차가 아니라 클립
        current = by_number.get(number)
        if current is None or (video["durationSec"] or 0) > (current["durationSec"] or 0):
            entry = dict(video)
            entry["ep"] = number
            entry["order"] = idx
            by_number[number] = entry
    episodes = [by_number[n] for n in sorted(by_number)][:max_episodes]
    return episodes


def build_drama(playlist: dict, detail: dict, probe: dict) -> dict:
    raw_title = detail.get("title") or playlist["title"]
    names = clean_title(raw_title, playlist["channelName"])
    episodes = episodes_from_videos(detail.get("videos") or [])
    if not episodes:
        return None

    synopsis = (probe.get("description") or detail.get("description") or "").strip()
    if names["title"] in ("", "제목 미상") and episodes:
        names["title"] = clean_title(episodes[0]["title"], playlist["channelName"])["title"]

    text_for_genre = " ".join([raw_title, names.get("titleEn") or "", synopsis[:200],
                               episodes[0]["title"] if episodes else ""])
    genres = detect_genres(text_for_genre, playlist["playlistId"])

    first = episodes[0]
    poster_id = first["videoId"]
    fresh = [e for e in episodes if e.get("publishedAgo") is not None]
    newest = min(fresh, key=lambda e: e["publishedAgo"]) if fresh else None
    avg = int(sum(e["durationSec"] for e in episodes) / max(1, len([e for e in episodes if e["durationSec"]]))) if any(e["durationSec"] for e in episodes) else 0

    captions_ko = probe.get("captionsKo")
    captions_any = probe.get("captionsAny")
    embeddable = probe.get("embeddable")
    korean_channel = bool(playlist.get("korean"))

    # 우선 수록 점수: 한국어 자막 > 자막 존재 > 임베드 가능 > 한국어 채널 > 회차 수
    score = 0
    if captions_ko is True:
        score += 40
    elif captions_any is True:
        score += 18
    elif korean_channel:
        score += 8
    if embeddable is True:
        score += 12
    elif embeddable is None:
        score += 4
    if korean_channel:
        score += 10
    score += min(len(episodes), 40) // 4

    return {
        "id": f"{playlist['channelKey']}-{playlist['playlistId']}",
        "playlistId": playlist["playlistId"],
        "title": names["title"],
        "titleEn": names.get("titleEn", ""),
        "titleZh": names.get("titleZh", ""),
        "titleRaw": raw_title,
        "synopsis": synopsis,
        "channel": playlist["channelName"],
        "channelKey": playlist["channelKey"],
        "channelHandle": playlist["channelHandle"],
        "genres": genres,
        "modern": detect_modern(text_for_genre, genres),
        "episodeCount": len(episodes),
        "avgDurationSec": avg,
        "posterVideoId": poster_id,
        "updatedAgoSec": newest["publishedAgo"] if newest else None,
        "updatedText": (newest["publishedText"] if newest else ""),
        "latestEpisode": newest["ep"] if newest else None,
        "thumbnail": f"https://i.ytimg.com/vi/{poster_id}/maxresdefault.jpg",
        "thumbnailFallback": f"https://i.ytimg.com/vi/{poster_id}/mqdefault.jpg",
        "verified": {
            "captionsKo": captions_ko,
            "captionsAny": captions_any,
            "embeddable": embeddable,
            "method": probe.get("method", "none"),
            "checkedVideoId": probe.get("videoId"),
            "checkedAt": probe.get("checkedAt"),
            "languages": probe.get("languages", []),
        },
        "score": score,
        "episodes": [
            {
                "n": e["ep"],
                "videoId": e["videoId"],
                "title": e["title"],
                "duration": e["durationText"],
                "durationSec": e["durationSec"],
                "publishedText": e.get("publishedText", ""),
                "thumb": f"https://i.ytimg.com/vi/{e['videoId']}/mqdefault.jpg",
            }
            for e in episodes
        ],
    }


# --------------------------------------------------------------------------
# 메인
# --------------------------------------------------------------------------


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="중드 카탈로그 수집")
    parser.add_argument("--out", default="data/dramas.json", help="출력 JSON 경로")
    parser.add_argument("--cache", default="data/probe_cache.json", help="검증 캐시 경로")
    parser.add_argument("--max-dramas", type=int, default=60, help="최대 수록 작품 수")
    parser.add_argument("--min-episodes", type=int, default=3, help="작품으로 인정할 최소 회차 수")
    parser.add_argument("--playlists-per-channel", type=int, default=40)
    parser.add_argument("--workers", type=int, default=4, help="재생목록 동시 요청 수")
    parser.add_argument("--no-probe", action="store_true", help="자막/임베드 검증 생략")
    parser.add_argument("--probe-age-days", type=int, default=10, help="검증 캐시 유효 기간")
    parser.add_argument("--probe-limit", type=int, default=0, help="이번 실행에서 새로 검증할 최대 작품 수(0=제한 없음)")
    parser.add_argument("--channels", default="", help="쉼표로 구분한 채널 key (기본: 한국에서 시청 가능한 채널)")
    parser.add_argument("--include-overseas", action="store_true",
                        help="한국에서 재생이 제한되는 중화권 채널까지 수집")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    started = time.time()
    wanted = {c.strip() for c in args.channels.split(",") if c.strip()}
    if wanted:
        channels = [c for c in CHANNELS if c["key"] in wanted]
    else:
        channels = [c for c in CHANNELS if args.include_overseas or c.get("region") == "KR"]

    print(f"[1/4] 채널 재생목록 수집 ({len(channels)}개 채널)")
    playlists = []
    for channel in channels:
        try:
            found = fetch_channel_playlists(channel, verbose=True)
        except Exception as err:  # noqa: BLE001
            print(f"  ! {channel['name']} 실패: {err}", file=sys.stderr)
            continue
        playlists.extend(found)

    # 제목 단계에서 클립/예고 위주 재생목록은 제외
    candidates = [p for p in playlists if not is_clip_title(p["title"])]
    candidates.sort(key=lambda p: (not p["korean"],))  # 한국어 채널 먼저
    per_channel = {}
    limited = []
    for item in candidates:
        key = item["channelKey"]
        if per_channel.get(key, 0) >= args.playlists_per_channel:
            continue
        per_channel[key] = per_channel.get(key, 0) + 1
        limited.append(item)
    candidates = limited
    print(f"  후보 재생목록 {len(candidates)}개 / 전체 {len(playlists)}개")

    print(f"[2/4] 재생목록 상세 확인 (동시 {args.workers})")

    def work(item):
        try:
            detail = fetch_playlist_videos(item["playlistId"])
        except Exception as err:  # noqa: BLE001
            if args.verbose:
                print(f"  ! {item['playlistId']} 실패: {err}", file=sys.stderr)
            return item, None
        return item, detail

    details = {}
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        for item, detail in pool.map(work, candidates):
            if detail and detail.get("videos"):
                details[item["playlistId"]] = (item, detail)

    # 회차 수 기준 필터
    picked = []
    for pid, (item, detail) in details.items():
        episodes = episodes_from_videos(detail["videos"])
        if len(episodes) < args.min_episodes:
            continue
        picked.append((len(episodes), item, detail))
    picked.sort(key=lambda x: (not x[1]["korean"], -x[0]))
    print(f"  회차 {args.min_episodes}개 이상 재생목록 {len(picked)}개")

    print("[3/4] 한국어 자막 / 임베드 검증")
    cache = load_probe_cache(args.cache)
    probes = {}
    if args.no_probe:
        print("  --no-probe: 검증 생략")
    else:
        done = 0
        for count, item, detail in picked:
            if done >= args.max_dramas:
                break
            episodes = episodes_from_videos(detail["videos"])
            target = episodes[0]["videoId"] if episodes else detail["videos"][0]["videoId"]
            entry = cache.get(target)
            if entry and cache_is_fresh(entry, args.probe_age_days):
                probes[target] = entry
                continue
            if args.probe_limit and done >= args.probe_limit:
                probes[target] = entry or {"videoId": target, "captionsKo": None, "captionsAny": None,
                                           "embeddable": None, "method": "skipped"}
                continue
            try:
                probes[target] = probe_video(target, verbose=args.verbose)
            except Exception as err:  # noqa: BLE001
                print(f"  ! 검증 실패 {target}: {err}", file=sys.stderr)
                probes[target] = {"videoId": target, "captionsKo": None, "captionsAny": None,
                                  "embeddable": None, "method": "error"}
            cache[target] = probes[target]
            done += 1
            time.sleep(0.4)
            if args.verbose:
                p = probes[target]
                print(f"  · {target} ko={p.get('captionsKo')} sub={p.get('captionsAny')} "
                      f"embed={p.get('embeddable')} ({p.get('method')})", file=sys.stderr)

    print("[4/4] dramas.json 작성")
    dramas = []
    missing_desc = 0
    for count, item, detail in picked:
        if len(dramas) >= args.max_dramas:
            break
        episodes = episodes_from_videos(detail["videos"])
        target = episodes[0]["videoId"] if episodes else detail["videos"][0]["videoId"]
        probe = dict(probes.get(target) or {"videoId": target, "captionsKo": None, "captionsAny": None,
                                            "embeddable": None, "method": "none"})
        if not probe.get("description"):
            meta = watch_meta(target, verbose=args.verbose)
            probe["description"] = meta.get("description", "")
            cache[target] = {**cache.get(target, {}), "videoId": target, "description": probe["description"]}
            missing_desc += 1
            time.sleep(0.3)
        drama = build_drama(item, detail, probe)
        if drama:
            dramas.append(drama)
    if missing_desc:
        print(f"  줄거리 보강 {missing_desc}건")

    # 같은 작품이 여러 재생목록에 있는 경우 회차가 많은 쪽만 남긴다
    unique = {}
    for drama in dramas:
        key = re.sub(r"[^0-9a-z가-힣\u4e00-\u9fff]", "", drama["title"].lower())
        key = key or drama["playlistId"]
        prev = unique.get(key)
        if prev is None or (drama["episodeCount"], drama["score"]) > (prev["episodeCount"], prev["score"]):
            unique[key] = drama
    dramas = list(unique.values())

    # 한국어 자막 확인 > 자막 존재 > 점수 순, 동일하면 회차 많은 순
    dramas.sort(key=lambda d: (-d["score"], -d["episodeCount"]))
    if args.max_dramas:
        dramas = dramas[: args.max_dramas]

    now = dt.datetime.now(dt.timezone.utc)
    stats = {
        "dramas": len(dramas),
        "episodes": sum(d["episodeCount"] for d in dramas),
        "captionsKoVerified": sum(1 for d in dramas if d["verified"]["captionsKo"] is True),
        "captionsAnyVerified": sum(1 for d in dramas if d["verified"]["captionsAny"] is True),
        "embeddableVerified": sum(1 for d in dramas if d["verified"]["embeddable"] is True),
        "koreanChannels": len([c for c in channels if c["korean"]]),
        "requests": _REQUEST_COUNT[0],
    }
    payload = {
        "generatedAt": now.isoformat(timespec="seconds"),
        "source": "YouTube 공식 채널 재생목록(iQIYI Korea·WeTV Korea·YOUKU Korea 등)",
        "stats": stats,
        "genres": GENRE_ORDER + ["현대극"],
        "channels": [
            {"key": c["key"], "name": c["name"], "handle": c["handle"], "korean": c["korean"],
             "region": c.get("region", "GLOBAL"), "captionsKoDefault": c.get("captionsKoDefault")}
            for c in channels
        ],
        "dramas": dramas,
    }

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    if not args.no_probe:
        save_probe_cache(args.cache, cache)

    elapsed = time.time() - started
    print(
        f"완료: 작품 {stats['dramas']}개 / 회차 {stats['episodes']}개 / "
        f"한국어 자막 확인 {stats['captionsKoVerified']}개 / 요청 {stats['requests']}회 / {elapsed:.0f}초"
    )
    print(f"저장: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
