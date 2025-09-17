document.addEventListener('DOMContentLoaded', () => {
  try {
    // ReportAIAssistant 클래스의 새 인스턴스를 생성합니다.
    new ReportAIAssistant();
  } catch (e) {
    console.error('Failed to initialize ReportAIAssistant:', e);
  }
});
