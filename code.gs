/**
 * 콘텐츠 파이프라인 v0.4
 * 인박스 메모 → 요일 담당 채널별 초안/프롬프트 자동 생성
 * v0.2: dryRun 플래그, 파일명 타임스탬프, 메모 스키마, 로그 개선
 * v0.3: 로그 시트 컬럼 확장(시각·상태·채널·제목·파일·메시지·재시도), 재시도 횟수 기록
 * v0.4: API 키 스크립트 속성화(하드코딩 금지), GEMINI 모드 사전 점검, 로그 시트 캐싱, 제목 길이 제한
 * 주의: 프로젝트 설정(Project Settings)에서 시간대를 Asia/Seoul(서울)로
 *       맞춰야 트리거가 한국 시간 기준으로 실행된다.
 */

const CONFIG = {
  ROOT_NAME: '콘텐츠 파이프라인',
  PARENT_NAME: '02_Creative Studio',
  LLM_MODE: 'PROMPT_ONLY',   // 'PROMPT_ONLY' 또는 'GEMINI'
  DRY_RUN: false,            // true면 초안 생성·processed 이동 없이 로그만 남긴다
  // GEMINI_API_KEY는 코드에 직접 넣지 않는다(하드코딩 금지. 깃허브 공개 대비).
  // 프로젝트 설정 → 스크립트 속성(Script Properties)에 'GEMINI_API_KEY' 이름으로 등록하면
  // getApiKey_()가 읽어 쓴다. 키 발급: aistudio.google.com (무료). GEMINI 모드 때만 필요.
  GEMINI_MODEL: 'gemini-2.0-flash',
  RETRY_LIMIT: 3,
  RETRY_DELAY_MS: 5000,
  LOG_SHEET_NAME: '콘텐츠 파이프라인 로그',
};

// 요일 매핑 (일=0 … 토=6)
const CHANNEL_MAP = {
  0: ['insta_on', 'naver_blog'],
  1: ['insta_off'],
  2: ['tistory', 'wordpress'],
  3: ['meliv'],
  4: ['tumblr', 'ameba'],
  5: ['seonmin_mov'],
  6: ['xiaohongshu', 'viriditas'],
};

// 메모 스키마에서 지원하는 필드
const SCHEMA_FIELDS = ['title', 'core_message', 'target_channels', 'target_languages', 'reference_url', 'keywords', 'source'];

// ---------- 초기 설치 ----------

function setupFolders() {
  const parent = getOrCreateFolder_(DriveApp.getRootFolder(), CONFIG.PARENT_NAME);
  const pipe = getOrCreateFolder_(parent, CONFIG.ROOT_NAME);
  ['인박스', 'processed', 'templates', '초안'].forEach(function (n) {
    getOrCreateFolder_(pipe, n);
  });
  ensureLogSheet_();
  Logger.log('설치 완료: ' + pipe.getUrl());
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runDaily') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runDaily').timeBased().atHour(20).nearMinute(0).everyDays(1).create();
  Logger.log('트리거 설치 완료: 매일 20시경 자동 실행 (프로젝트 시간대 기준)');
}

// ---------- 메인 ----------

function runDaily() {
  // GEMINI 모드인데 키가 없으면 시작 전에 실패시킨다. 처리 도중 실패하면 메모가
  // processed로 넘어가 초안 없이 끝날 수 있으므로, 인박스를 그대로 둔 채 즉시 중단한다.
  if (CONFIG.LLM_MODE === 'GEMINI' && !PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY')) {
    log_('ERROR', '-', '-', 'GEMINI 모드인데 스크립트 속성에 GEMINI_API_KEY가 없음. 인박스를 처리하지 않고 중단');
    return;
  }
  const channels = CHANNEL_MAP[seoulDay_()] || [];
  if (!channels.length) {
    log_('INFO', '-', '-', '오늘 담당 채널 없음');
    return;
  }
  const inbox = getFolder_('인박스');
  const files = inbox.getFiles();
  let count = 0;
  while (files.hasNext()) {
    const file = files.next();
    try {
      processMemo_(file, channels);
      count++;
    } catch (e) {
      log_('ERROR', file.getName(), '-', e.message);
    }
  }
  log_('INFO', '-', '-', '실행 완료 (모드: ' + CONFIG.LLM_MODE + (CONFIG.DRY_RUN ? ', DRY_RUN' : '') + '): 처리 ' + count + '건, 채널 [' + channels.join(', ') + ']');
}

// 서울(Asia/Seoul) 기준 요일을 반환 (일=0 … 토=6).
// new Date().getDay()는 스크립트 시간대를 따라가므로, 시간대 설정과 무관하게
// 항상 서울 기준으로 계산한다. KST는 UTC+9, 서머타임 없음.
function seoulDay_() {
  const seoulMs = new Date().getTime() + 9 * 60 * 60 * 1000;
  return new Date(seoulMs).getUTCDay();
}

function processMemo_(file, channels) {
  if (!isSupportedMemo_(file)) {
    moveToProcessed_(file);
    log_('SKIP', file.getName(), '-', '지원하지 않는 파일 형식 (구글 문서 또는 텍스트 파일만)');
    return;
  }
  const raw = readMemo_(file);
  if (!raw || !raw.trim()) {
    moveToProcessed_(file);
    log_('SKIP', file.getName(), '-', '빈 메모');
    return;
  }
  const parsed = parseMemo_(raw);
  const f = parsed.fields;
  const fieldKeys = Object.keys(f);
  if (fieldKeys.length) {
    log_('INFO', file.getName(), '-', '스키마 메모 인식 (필드: ' + fieldKeys.join(', ') + ')');
  }
  const memoBody = (f.core_message || parsed.body || '').trim();
  if (!memoBody) {
    moveToProcessed_(file);
    log_('SKIP', file.getName(), '-', '본문 없음 (core_message도 본문도 비어 있음)');
    return;
  }
  const title = sanitizeTitle_(f.title || firstLine_(memoBody));
  // 대상 채널: 스키마의 target_channels가 있으면 요일 매핑 대신 그 채널로 발행한다.
  let targets = channels;
  if (f.target_channels) {
    targets = f.target_channels.split(',')
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
    log_('INFO', file.getName(), '-', '채널 지정 발행: [' + targets.join(', ') + '] (요일 매핑 무시)');
  }
  const meta = {
    TITLE: title,
    MEMO: memoBody,
    LANG: f.target_languages || '',
    URL: f.reference_url || '',
    KEYWORDS: f.keywords || '',
    SOURCE: f.source || '',
  };
  targets.forEach(function (ch) {
    const template = getTemplate_(ch);
    if (!template) {
      log_('SKIP', file.getName(), ch, '템플릿 없음: templates/' + ch + '.txt');
      return;
    }
    const prompt = fillTemplate_(template, meta);
    let body;
    if (CONFIG.LLM_MODE === 'GEMINI') {
      try {
        body = withRetry_(function () { return callGemini_(prompt); }, ch);
      } catch (e) {
        log_('ERROR', file.getName(), ch, e.message, title, e.retries || 0);
        return; // 이 채널은 건너뛰고 나머지 채널은 계속 처리
      }
    } else {
      body = '[PROMPT_ONLY 모드] 아래 프롬프트를 챗봇에 붙여넣어 초안을 만든 뒤 이 문서를 교체하세요.\n\n---\n\n' + prompt;
    }
    if (CONFIG.DRY_RUN) {
      log_('SUCCESS', file.getName(), ch, '[DRYRUN] 초안 생성 생략', title);
      return;
    }
    try {
      const doc = createDraftDoc_(ch, title, body);
      log_('SUCCESS', file.getName(), ch, '초안 생성 완료: ' + doc.getUrl(), title);
    } catch (e) {
      log_('ERROR', file.getName(), ch, '초안 문서 생성 실패: ' + e.message, title);
    }
  });
  // 일부 채널이 실패해도 메모는 processed로 이동한다.
  // 요일이 바뀌면 담당 채널도 바뀌므로, 인박스에 남기면 내일 다른 요일의 채널로
  // 같은 메모가 중복 발행된다. 실패 채널은 로그 시트의 ERROR 행으로 추적한다.
  moveToProcessed_(file);
}

// ---------- 헬퍼 ----------

function pipeRoot_() {
  const parent = getOrCreateFolder_(DriveApp.getRootFolder(), CONFIG.PARENT_NAME);
  return getOrCreateFolder_(parent, CONFIG.ROOT_NAME);
}

function getFolder_(name) {
  return getOrCreateFolder_(pipeRoot_(), name);
}

function getOrCreateFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

// 구글 문서와 텍스트 계열 파일만 메모로 인정한다. 이미지·PDF 등이 인박스에
// 들어와도 읽지 않고 SKIP 처리된다.
function isSupportedMemo_(file) {
  const mt = file.getMimeType();
  return mt === 'application/vnd.google-apps.document' || mt.indexOf('text/') === 0;
}

function readMemo_(file) {
  let text;
  if (file.getMimeType() === 'application/vnd.google-apps.document') {
    text = DocumentApp.openById(file.getId()).getBody().getText();
  } else {
    text = file.getBlob().getDataAsString('UTF-8');
  }
  return text.replace(/\r\n?/g, '\n'); // 윈도우 개행(CRLF/CR) 정규화
}

// 메모 텍스트 파싱. 문서 첫 줄부터 '필드: 값' 형식의 줄이 이어지면 스키마로
// 인식하고, 나머지는 본문으로 돌려준다. 첫 줄이 필드 형식이 아니면 스키마 없음
// (일반 메모)으로 판정해 전체가 본문이 된다. 하위호환 유지.
function parseMemo_(text) {
  const lines = text.split('\n');
  const fields = {};
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
    if (!m) break;
    const key = m[1].toLowerCase();
    if (SCHEMA_FIELDS.indexOf(key) === -1) break;
    fields[key] = m[2].trim();
    i++;
  }
  const body = lines.slice(i).join('\n').trim();
  return { fields: fields, body: body };
}

// 템플릿의 {{...}} 자리를 메타데이터로 채운다. 정의되지 않은 자리는 그대로 둔다.
function fillTemplate_(template, meta) {
  let out = template;
  Object.keys(meta).forEach(function (k) {
    out = out.split('{{' + k + '}}').join(meta[k]);
  });
  return out;
}

function firstLine_(text) {
  const line = text.trim().split('\n')[0].replace(/^#+\s*/, '');
  return line.slice(0, 50) || '무제';
}

function sanitizeTitle_(title) {
  // 파일명에 쓸 수 없는 문자 치환 + 50자 제한(스키마 title이 아주 길 때 대비).
  const cleaned = title.replace(/[\\/:*?"<>|]/g, '-').trim();
  return cleaned.length > 50 ? cleaned.slice(0, 50) : cleaned;
}

function getTemplate_(channel) {
  const it = getFolder_('templates').getFilesByName(channel + '.txt');
  if (!it.hasNext()) return null;
  return it.next().getBlob().getDataAsString('UTF-8');
}

function createDraftDoc_(channel, title, body) {
  const folder = getOrCreateFolder_(getFolder_('초안'), channel);
  const stamp = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd_HHmmss');
  const doc = DocumentApp.create(stamp + '_' + channel + '_' + title);
  doc.getBody().setText(body);
  DriveApp.getFileById(doc.getId()).moveTo(folder);
  return doc;
}

function moveToProcessed_(file) {
  if (CONFIG.DRY_RUN) {
    log_('INFO', file.getName(), '-', '[DRYRUN] processed 이동 생략');
    return;
  }
  file.moveTo(getFolder_('processed'));
}

function withRetry_(fn, channel) {
  let lastErr;
  for (let i = 0; i < CONFIG.RETRY_LIMIT; i++) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
      // 마지막 시도 뒤에는 불필요하게 대기하지 않는다.
      if (i < CONFIG.RETRY_LIMIT - 1) Utilities.sleep(CONFIG.RETRY_DELAY_MS);
    }
  }
  const err = new Error('재시도 ' + CONFIG.RETRY_LIMIT + '회 실패 (' + channel + '): ' + lastErr.message);
  err.retries = CONFIG.RETRY_LIMIT; // log_가 이 값을 재시도 컬럼에 기록한다.
  throw err;
}

// API 키는 스크립트 속성에서만 읽는다. 코드와 깃허브 레포에 키가 노출되지 않는다.
function getApiKey_() {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('스크립트 속성에 GEMINI_API_KEY가 없음');
  return key;
}

function callGemini_(prompt) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + CONFIG.GEMINI_MODEL + ':generateContent?key=' + getApiKey_();
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  let data;
  try {
    data = JSON.parse(res.getContentText());
  } catch (e) {
    throw new Error('Gemini API ' + code + ': 응답을 파싱할 수 없음');
  }
  if (code !== 200) {
    throw new Error('Gemini API ' + code + ': ' + (data.error ? data.error.message : '알 수 없음'));
  }
  const cand = data.candidates && data.candidates[0];
  const part = cand && cand.content && cand.content.parts && cand.content.parts[0];
  if (!part || part.text === undefined) {
    throw new Error('Gemini 응답에 본문 없음 (안전 필터 차단 가능성)');
  }
  return part.text;
}

// ---------- 로그 ----------

// 로그 스프레드시트는 한 번 열면 전역 캐시에 둔다. log_가 호출될 때마다 드라이브를
// 다시 검색하면 실행 시간과 쿼터를 불필요하게 소모한다.
let logSheetCache_ = null;

function ensureLogSheet_() {
  if (logSheetCache_) return logSheetCache_;
  const it = DriveApp.getFilesByName(CONFIG.LOG_SHEET_NAME);
  let ss = null;
  while (it.hasNext()) {
    const f = it.next();
    // 같은 이름의 일반 파일이 있을 수 있으므로 스프레드시트만 대상으로 한다.
    if (f.getMimeType() === 'application/vnd.google-apps.spreadsheet') {
      ss = SpreadsheetApp.openById(f.getId());
      break;
    }
  }
  if (!ss) {
    ss = SpreadsheetApp.create(CONFIG.LOG_SHEET_NAME);
    DriveApp.getFileById(ss.getId()).moveTo(pipeRoot_());
  }
  logSheetCache_ = ss;
  const sh = ss.getSheets()[0];
  if (sh.getLastRow() === 0) sh.appendRow(['시각', '상태', '채널', '제목', '파일', '메시지', '재시도']);
  return ss;
}

// 로그 시트에 한 줄 기록. 컬럼 순서: 시각, 상태, 채널, 제목, 파일, 메시지, 재시도.
// 상태: SUCCESS(초안 생성 완료) / ERROR(재시도 후에도 실패) / SKIP(처리하지 않고 넘어감) / INFO(실행 요약 등 참고 기록).
// 재시도 횟수는 withRetry_가 실패 에러에 담아 넘긴 e.retries 값이 그대로 기록된다(성공·비해당은 0).
function log_(status, file, channel, message, title, retries) {
  try {
    ensureLogSheet_().getSheets()[0].appendRow(
      [new Date(), status, channel || '-', title || '-', file || '-', message || '', retries || 0]);
  } catch (e) {
    Logger.log('로그 기록 실패: ' + e.message);
  }
}
