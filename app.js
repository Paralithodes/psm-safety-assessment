/**
 * PSM 안전수준 평가 - 화면 로직
 * 문제은행 데이터는 questions.js 의 QUESTION_BANK 를 사용합니다.
 *
 * 일반 사용자는 두 가지만 이용합니다.
 *  - exam  : "PSM 수준평가" - 12대 요소에서 골고루 뽑은 25문항에 답을 체크/기입하고,
 *            평가 종료 후 한꺼번에 채점하는 정식 시험
 *  - study : "요소별 학습" - 12대 요소별로 정리된 핵심 내용을 학습하는 모드 (문항이 아님)
 *
 * "체크리스트 평가"와 응시자 결과/분석은 관리자 전용이며 비밀번호로 보호됩니다.
 */

const ADMIN_PASSWORD = "sheq1357";

// ---- 체크리스트 모드 점수 척도 (관리자 전용) ----
const SCORE_SCALE = [
  { value: 3, label: "우수", color: "#2e7d32" },
  { value: 2, label: "양호", color: "#1e88e5" },
  { value: 1, label: "보통", color: "#fb8c00" },
  { value: 0, label: "미흡", color: "#e53935" }
];
const MAX_SCORE = Math.max(...SCORE_SCALE.map(s => s.value));
const NA_VALUE = "na";

const GRADE_TABLE = [
  { min: 90, grade: "A", label: "우수", color: "#2e7d32" },
  { min: 75, grade: "B", label: "양호", color: "#1e88e5" },
  { min: 60, grade: "C", label: "보통(개선 필요)", color: "#fb8c00" },
  { min: 0, grade: "D", label: "미흡(시급 개선)", color: "#e53935" }
];

const EXAM_TOTAL_QUESTIONS = 25;
const STORAGE_KEY = "psm_assessment_v5";
const COMPANY_NAME = "씨지앤대산전력";

// 응시 결과를 자동으로 전송할 구글시트(Apps Script 웹앱) 주소.
// 이 주소는 "쓰기 전용 우체통"이라 결과를 받기만 하고, 결과를 읽는 것은
// 이 주소를 만든 구글시트 소유자만 가능합니다(시트가 비공개이기 때문).
const RESULTS_ENDPOINT_URL = "https://script.google.com/macros/s/AKfycbzE32Dpz74iHOgp3zZxgBLw7zLptOO7VDaQLmVVQeNjHmjNqv3lcU7YtJLiySXN-n0/exec";

function sendResultToCloud(entry) {
  if (!RESULTS_ENDPOINT_URL || RESULTS_ENDPOINT_URL.indexOf("http") !== 0) return;
  fetch(RESULTS_ENDPOINT_URL, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(entry)
  }).catch(() => {
    // 네트워크 오류 등으로 실패해도 로컬 저장(localStorage)에는 이미 남아있으므로
    // 조용히 무시합니다. (JSON 내보내기로 수동 전달하는 방법은 계속 사용 가능)
  });
}

const MODE_LABEL = {
  exam: { name: "PSM 수준평가", icon: "📝" },
  study: { name: "요소별 학습", icon: "📚" }
};

// ---- 전역 문항 색인 ----
const QUESTION_INDEX = {}; // qId -> { cat, q }
QUESTION_BANK.categories.forEach(cat => {
  cat.questions.forEach(q => { QUESTION_INDEX[q.id] = { cat, q }; });
});

// ---- 화면 영역 상태 (세션 한정, 저장 안 함) ----
let appArea = "user";      // "user" | "admin"
let adminAuthed = false;
let adminView = "results"; // "checklist" | "results" | "analysis"
let checklistView = QUESTION_BANK.categories[0].id; // categoryId 또는 "result" (관리자 체크리스트용)
let studyView = QUESTION_BANK.categories[0].id;     // categoryId (요소별 학습용)

// ---- 영구 저장 상태 ----
let state = {
  meta: { date: new Date().toISOString().slice(0, 10) },
  subject: { department: "", position: "", name: "" },
  mode: "exam",
  checklist: {}, // { [catId]: { [qId]: { score: number|"na"|null, note: string } } }
  study: {},     // { [catId]: { done: bool } }
  exam: {
    phase: "intake",   // "intake" | "taking" | "submitted"
    id: null,
    questionIds: null,
    answers: {},        // { [qId]: { selected: number|null, text: string } }
    manualGrades: {},   // { [qId]: true|false }
    startedAt: null,
    submittedAt: null
  },
  examLog: [] // 관리자 화면에서 보는 응시자 결과 기록
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = {
        ...state, ...parsed,
        meta: { ...state.meta, ...(parsed.meta || {}) },
        subject: { ...state.subject, ...(parsed.subject || {}) },
        exam: { ...state.exam, ...(parsed.exam || {}) },
        examLog: parsed.examLog || []
      };
    }
  } catch (e) {
    console.warn("저장된 데이터를 불러오지 못했습니다.", e);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function escapeHtml(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round1(n) { return Math.round(n * 10) / 10; }
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function formatDT(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function gradeOf(pct) {
  if (pct === null || pct === undefined) return { grade: "-", label: "평가 미완료", color: "#9e9e9e" };
  return GRADE_TABLE.find(g => pct >= g.min);
}

function nextMin(g) {
  const idx = GRADE_TABLE.indexOf(g);
  return idx > 0 ? GRADE_TABLE[idx - 1].min - 0.1 + "% 미만" : "";
}

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
