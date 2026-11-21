/**
 * instagram.gs v2 - Instagram 자동 발행 (Instagram API 통합 로그인, SUAT)
 * 콘텐츠 파이프라인 v0.4의 code.gs, publish.gs와 함께 동작한다.
 *
 * v1과의 차이: OAuth 인증·토큰 갱신이 필요 없어졌다. 메타 대시보드의
 * '액세스 토큰 생성'에서 발급한 시스템 사용자 액세스 토큰(만료 없음)을
 * 스크립트 속성에 넣어두기만 하면 된다. API 호스트는 graph.facebook.com.
 *
 * 주의: Instagram API에는 '초안' 개념이 없다. media_publish 호출 순간 즉시 공개된다.
 *       IG_CONFIG.MODE가 'publish'일 때만 실제 발행하고 기본값 'off'에서는
 *       초안 문서만 만들고 발행을 건너뛴다.
 *
 * 필수 스크립트 속성(프로젝트 설정 - 스크립트 속성):
 *   IG_TOKEN_ON, IG_TOKEN_OFF, IG_TOKEN_MELIV - 대시보드에서 발급한 계정별 토큰
 * 자동 저장 속성(코드가 관리, 손대지 않음):
 *   IG_ON_USER_ID, IG_ON_USERNAME (off, meliv 동일 규칙)
 */

const IG_CONFIG = {
  API_VERSION: 'v26.0',   // Meta가 버전을 폐기하면 여기만 바꾼다 (2026-11 기준 v21.0~v27.0 지원, 최신 v27.0)
  MODE: 'publish',            // 'off' = 초안 문서만 생성, 'publish' = Instagram에 즉시 발행
  CAPTION_MAX: 2200,      // Instagram 캡션 글자수 제한
};

// 채널(code.gs CHANNEL_MAP의 키) -> 계정 키
const IG_CHANNELS = {
  insta_on: 'on',
  insta_off: 'off',
  meliv: 'meliv',
};

// 계정 키 -> 표시 이름 (로그에 쓴다)
const IG_ACCOUNTS = {
  on: 'seonmin.on',
  off: 'seonmin.off',
  meliv: 'Meliv Music',
};

const IG_GRAPH_BASE = 'https://graph.facebook.com';

// ---------- 토큰 / 계정 ID ----------

// 계정 토큰을 읽는다. SUAT는 만료가 없으므로 갱신 처리가 필요 없다.
function igGetToken_(account) {
  const token = PropertiesService.getScriptProperties()
    .getProperty('IG_TOKEN_' + account.toUpperCase());
  if (!token) {
    throw new Error('스크립트 속성 IG_TOKEN_' + account.toUpperCase()
      + ' 없음. 메타 대시보드에서 발급한 토큰을 저장하세요.');
  }
  return token;
}

// Instagram 계정 ID 조회. 첫 실행 때 API에서 받아 저장하고 이후에는 저장값을 쓴다.
// SUAT 토큰으로는 /me가 시스템 사용자를 가리키므로 /me/assigned_instagram_accounts 엣지를 써야 한다.
function igGetUserId_(account, token) {
  const KEY = 'IG_' + account.toUpperCase();
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty(KEY + '_USER_ID');
  if (cached) return cached;

  const label = 'instagram_' + account;
  const res = igApi_(label, token, 'me/assigned_instagram_accounts', 'get', { fields: 'id,username' });
  const rows = res.data || [];
  if (!rows.length) {
    throw new Error('연결된 Instagram 계정이 없음 (' + label
      + '). 대시보드 액세스 토큰 생성에서 계정을 추가했는지 확인.');
  }
  let row = rows[0];
  if (rows.length > 1) {
    const match = rows.filter(function (r) {
      return String(r.username || '').toLowerCase() === String(IG_ACCOUNTS[account]).toLowerCase();
    });
    if (match.length === 1) {
      row = match[0];
    } else {
      throw new Error('토큰에 여러 Instagram 계정이 연결되어 어느 것인지 특정 못함 (' + label
        + '). 연결된 username: ' + rows.map(function (r) { return r.username || '?'; }).join(', '));
    }
  }
  props.setProperty(KEY + '_USER_ID', String(row.id));
  if (row.username) props.setProperty(KEY + '_USERNAME', String(row.username));
  log_('INFO', 'igGetUserId_', label,
    'Instagram 계정 ID 저장: ' + (row.username || '?') + ' (' + row.id + ')');
  return String(row.id);
}

// ---------- 발행 ----------

// publish_에서 호출된다. Instagram은 초안이 없고 즉시 공개되므로 MODE가 'publish'일 때만 동작.
// force가 true면 MODE와 무관하게 발행한다(테스트용).
function instagramPublish_(channel, title, body, meta, force) {
  const account = IG_CHANNELS[channel];
  if (!account) throw new Error('Instagram 채널이 아님: ' + channel);
  if (!force && IG_CONFIG.MODE !== 'publish') {
    log_('INFO', '-', channel, 'Instagram 자동 발행 OFF (IG_CONFIG.MODE). 초안 문서만 생성.');
    return null;
  }
  const imageUrl = (meta && meta.IMAGE_URL) || '';
  if (!imageUrl) throw new Error('image_url이 없음. 메모 스키마에 image_url: <공개 이미지 URL> 줄을 추가하세요.');
  const token = igGetToken_(account);
  const userId = igGetUserId_(account, token);
  const label = 'instagram_' + account;

  // 1) 미디어 컨테이너 생성 (image_url + caption)
  const container = igApi_(label, token, userId + '/media', 'post', {
    image_url: imageUrl,
    caption: igCaption_(title, body),
  });

  // 2) 이미지 처리 대기 (JPEG은 보통 즉시 FINISHED)
  igWaitContainer_(label, token, container.id);

  // 3) 발행
  const published = igApi_(label, token, userId + '/media_publish', 'post', { creation_id: container.id });

  let permalink = '';
  try {
    const info = igApi_(label, token, published.id, 'get', { fields: 'permalink' });
    permalink = info.permalink || '';
  } catch (e) { /* permalink 조회 실패는 발행 성공에 영향 없다 */ }

  return { ID: published.id, URL: permalink };
}

// Instagram은 제목이 없다. 제목 + 빈 줄 + 본문을 캡션으로 합치고 2200자 제한.
function igCaption_(title, body) {
  let caption = (title ? title + '\n\n' : '') + String(body || '');
  caption = caption.trim();
  if (caption.length > IG_CONFIG.CAPTION_MAX) {
    caption = caption.slice(0, IG_CONFIG.CAPTION_MAX - 3) + '...';
  }
  return caption;
}

function igWaitContainer_(label, token, creationId) {
  for (let i = 0; i < 10; i++) {
    const st = igApi_(label, token, creationId, 'get', { fields: 'status_code' });
    if (st.status_code === 'FINISHED') return;
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') {
      throw new Error('미디어 컨테이너 상태 ' + st.status_code + ' (creation_id: ' + creationId + ')');
    }
    Utilities.sleep(3000);
  }
  throw new Error('미디어 컨테이너 처리 대기 시간 초과 (creation_id: ' + creationId + ')');
}

// Graph API 공통 호출 (graph.facebook.com). label은 에러 메시지에 들어갈 채널 표시.
function igApi_(label, token, path, method, params) {
  params = params || {};
  params.access_token = token;
  let url = IG_GRAPH_BASE + '/' + IG_CONFIG.API_VERSION + '/' + path;
  const options = { method: method, muteHttpExceptions: true };
  if (method === 'post') {
    options.payload = params;
  } else {
    const qs = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    url += '?' + qs;
  }
  const res = UrlFetchApp.fetch(url, options);
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (err) {}
  if (res.getResponseCode() !== 200 || data.error) {
    const msg = (data.error && (data.error.message || data.error.error_user_msg || data.error.type))
      || res.getContentText().slice(0, 200);
    throw new Error('Instagram API ' + res.getResponseCode() + ' (' + label + '): ' + msg);
  }
  return data;
}

// ---------- 테스트 / 보조 ----------

// 토큰 상태 확인: 각 토큰으로 API를 호출해 실제 연결된 Instagram 계정(username, ID)을 로그에 찍는다.
// 최초 실행 시 계정 ID도 자동 저장된다. 테스트의 첫 단계로 이걸 돌린다.
function instaStatus() {
  Object.keys(IG_ACCOUNTS).forEach(function (account) {
    try {
      const token = igGetToken_(account);
      const res = igApi_('instagram_' + account, token,
        'me/assigned_instagram_accounts', 'get', { fields: 'id,username' });
      const rows = res.data || [];
      if (!rows.length) {
        Logger.log(IG_ACCOUNTS[account] + ' (' + account + '): 토큰은 있으나 연결된 Instagram 계정이 없음');
        return;
      }
      rows.forEach(function (r) {
        Logger.log(IG_ACCOUNTS[account] + ' (' + account + '): 토큰 유효, 연결 계정 = '
          + (r.username || '?') + ' (ID ' + r.id + ')');
      });
    } catch (e) {
      Logger.log(IG_ACCOUNTS[account] + ' (' + account + '): 오류 - ' + e.message);
    }
  });
}

// 발행 동작 점검용: 테스트 게시물을 실제로 올린다. 즉시 공개되니 주의!
// 게시 후 인스타 앱에서 바로 삭제하면 된다. 에디터 실행 버튼은 인자를 못 넘기므로 기본값 on.
function instaTestPost(account) {
  account = account || 'on';  // off/meliv 테스트 시 이 따옴표 안 값만 바꾼다.
  if (!IG_ACCOUNTS[account]) throw new Error("계정은 'on', 'off', 'meliv' 중 하나여야 함: " + account);
  const channel = account === 'on' ? 'insta_on' : (account === 'off' ? 'insta_off' : 'meliv');
  const r = instagramPublish_(
    channel,
    '파이프라인 발행 테스트',
    '자동 발행 테스트입니다. 이 게시물은 곧 삭제됩니다.',
    { IMAGE_URL: 'https://picsum.photos/1080/1080' },
    true);
  Logger.log('발행 성공: ' + (r.URL || 'permalink 없음') + ' (ID: ' + r.ID + ')');
  log_('SUCCESS', 'instaTestPost', 'instagram_' + account,
    'Instagram 발행 테스트 성공: ' + (r.URL || ''));
}
