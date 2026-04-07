// ============================================================
// config.ts — プラグイン設定画面（設定項目なし）
// ============================================================

function init(): void {
  const btnCancel = document.getElementById("btn-cancel");
  if (!btnCancel) return;
  btnCancel.addEventListener("click", () => history.back());
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

