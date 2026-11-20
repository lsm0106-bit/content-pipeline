/**
 * publish.gs v1 - WordPress.com 자동 발행 (OAuth2)
 * 콘텐츠 파이프라인 v0.4의 code.gs와 함께 동작한다.
 *
 * 구조: processMemo_ 초안 생성 후 publish_(channel, title, body) 호출 ->
 *       WordPress.com REST API v1.1로 글을 올린다. 기본 상태는 draft(초안).
 *
 * 필수 스크립트 속성(프로젝트 설정 -> 스크립트 속성):
 *   WP_CLIENT_ID     - developer.wordpress.com/apps 에서 발급
 *   WP_CLIENT_SECRET - 위와 같음
 * 선택 속성:
 *   WP_REDIRECT_URI  - 인증 콜백 URL 직접 지정. 웹앱 /exec 배포 URL을 등록해 쓴다.
 *                      설정이 없으면 /usercallback 기본값을 쓴다.
 * 자동 저장되는 속성:
 *   WP_ACCESS_TOKEN  - wpAuthorize_ 인증 성공 시 자동 저장. 코드/깃허브에 올리지 않는다.
 */

const WP_CONFIG = {
  SITE: 'seonminlaura.wordpress.com',
  STATUS: 'draft',            // 품질 검수 전까지 draft. 검수 후 'publish'로 바꾼다.
  SCOPE: 'posts',
  CHANNELS: ['wordpress'],    // 자동 발행 대상 채널. 목록에 없는 채널은 건너뛴다.
};

const WP_AUTH_URL = 'https://public-api.wordpress.com/oauth2/authorize';
const WP_TOKEN_URL = 'https://public-api.wordpress.com/oauth2/token';
const WP_API_BASE = 'https://public-api.wordpress.com/rest/v1.1/sites/' + WP_CONFIG.SITE;

// ---------- 인증 (최초 1회) ----------

// 실행하면 로그에 인증 URL이 찍힌다. 그 URL을 브라우저에서 열고 승인하면
// WordPress가 콜백으로 리다이렉트하고, doGet이 토큰을 받아 저장한다.
function wpAuthorize_() {
  const clientId = PropertiesService.getScriptProperties().getProperty('WP_CLIENT_ID');
  if (!clientId) throw new Error('스크립트 속성에 WP_CLIENT_ID가 없음');
  const url = WP_AUTH_URL
    + '?client_id=' + encodeURIComponent(clientId)
    + '&redirect_uri=' + encodeURIComponent(wpRedirectUri_())
    + '&response_type=code'
    + '&scope=' + encodeURIComponent(WP_CONFIG.SCOPE);
  Logger.log('아래 URL을 브라우저에서 열어 승인하세요:\n\n' + url);
  return url;
}

function wpRedirectUri_() {
  // WP_REDIRECT_URI 속성이 있으면 그 값을 우선한다(웹앱 /exec 배포 URL).
  const configured = PropertiesService.getScriptProperties().getProperty('WP_REDIRECT_URI');
  if (configured) return configured;
  return 'https://script.google.com/macros/d/' + ScriptApp.getScriptId() + '/usercallback';
}

// 웹앱 배포 후 WordPress 리다이렉트를 받는다. 배포가 없으면 동작하지 않는다.
function doGet(e) {
  const code = e && e.parameter && e.parameter.code;
  if (!code) {
    return HtmlService.createHtmlOutput(
      '잘못된 접근입니다. wpAuthorize_를 실행하고 로그에 찍힌 URL을 여세요.');
  }
  const props = PropertiesService.getScriptProperties();
  const res = UrlFetchApp.fetch(WP_TOKEN_URL, {
    method: 'post',
    payload: {
      client_id: props.getProperty('WP_CLIENT_ID'),
      client_secret: props.getProperty('WP_CLIENT_SECRET'),
      redirect_uri: wpRedirectUri_(),
      code: code,
      grant_type: 'authorization_code',
    },
    muteHttpExceptions: true,
  });
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (err) {}
  if (res.getResponseCode() !== 200 || !data.access_token) {
    log_('ERROR', '-', 'wordpress', 'WordPress 인증 실패: ' + res.getContentText().slice(0, 300));
    return HtmlService.createHtmlOutput(
      '인증 실패: ' + (data.error_description || data.error || res.getContentText().slice(0, 300)));
  }
  props.setProperty('WP_ACCESS_TOKEN', data.access_token);
  log_('INFO', '-', 'wordpress', 'WordPress 인증 완료. WP_ACCESS_TOKEN 저장됨 (scope: ' + (data.scope || '-') + ')');
  return HtmlService.createHtmlOutput(
    '인증 완료! 이 창은 닫아도 됩니다. 앱스 스크립트로 돌아가 wpTestDraft를 실행하세요.');
}

// ---------- 발행 ----------

// code.gs의 processMemo_에서 초안 생성 성공 후 호출된다.
// WP_CONFIG.CHANNELS에 없는 채널은 조용히 건너뛴다(다른 채널 자동 발행은 아직 미지원).
function publish_(channel, title, body) {
  if (WP_CONFIG.CHANNELS.indexOf(channel) === -1) return null;
  const token = PropertiesService.getScriptProperties().getProperty('WP_ACCESS_TOKEN');
  if (!token) throw new Error('WP_ACCESS_TOKEN 없음. wpAuthorize_를 실행해 인증하세요.');
  const res = UrlFetchApp.fetch(WP_API_BASE + '/posts/new', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({
      title: title,
      content: toWpHtml_(body),
      status: WP_CONFIG.STATUS,
    }),
    muteHttpExceptions: true,
  });
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (err) {}
  if (res.getResponseCode() !== 200) {
    throw new Error('WordPress API ' + res.getResponseCode() + ': '
      + (data.message || res.getContentText().slice(0, 200)));
  }
  return data; // data.URL, data.ID 등
}

// 본문 텍스트를 WordPress 본문 HTML로 바꾼다.
// 마크다운 완전 변환은 아니고: HTML 특수문자 이스케이프 + 빈 줄 기준 문단 분할 + 줄바꿈 br 처리.
function toWpHtml_(text) {
  const escaped = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.split(/\n\s*\n/)
    .map(function (p) { return '<p>' + p.trim().replace(/\n/g, '<br>\n') + '</p>'; })
    .join('\n');
}

// ---------- 테스트 / 보조 ----------

// 발행 동작 점검용: 테스트 글 하나를 WordPress에 초안으로 올린다.
function wpTestDraft() {
  const r = publish_(
    'wordpress',
    '파이프라인 발행 테스트',
    '이 글은 자동 발행 테스트입니다.\n\n이 문단이 WordPress에서 문단으로 나뉘어 보이면 HTML 변환도 정상이에요.\n\n이 글은 초안 상태라 독자에게는 보이지 않습니다.');
  Logger.log('업로드 성공: ' + (r.URL || 'URL 없음') + ' (ID: ' + r.ID + ', 상태: ' + r.status + ')');
  log_('SUCCESS', 'wpTestDraft', 'wordpress', 'WordPress 초안 업로드 성공: ' + (r.URL || ''), '파이프라인 발행 테스트');
}

// 초안을 실제 발행(public)으로 전환한다. postId는 wpTestDraft 로그의 ID 또는
// WordPress 관리 화면(게시물 -> 초안)에서 확인할 수 있다.
function wpPublishById(postId) {
  const token = PropertiesService.getScriptProperties().getProperty('WP_ACCESS_TOKEN');
  if (!token) throw new Error('WP_ACCESS_TOKEN 없음. wpAuthorize_를 실행해 인증하세요.');
  const res = UrlFetchApp.fetch(WP_API_BASE + '/posts/' + postId, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ status: 'publish' }),
    muteHttpExceptions: true,
  });
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (err) {}
  if (res.getResponseCode() !== 200) {
    throw new Error('WordPress API ' + res.getResponseCode() + ': '
      + (data.message || res.getContentText().slice(0, 200)));
  }
  Logger.log('발행 완료: ' + (data.URL || ''));
  return data;
}
