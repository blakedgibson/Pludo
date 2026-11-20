using UnityEngine;
using UnityEngine.UIElements;

public class CreateScreenController : MonoBehaviour
{
    private VisualElement    _root;
    private MainAppController _app;

    private TextField     _promptInput;
    private Button        _submitBtn;
    private Label         _submitIcon;
    private VisualElement _resultBanner;
    private Label         _resultIcon, _resultText;

    public void Setup(VisualElement root, MainAppController app)
    {
        _root = root;
        _app  = app;
        BindUI();
    }

    public void OnShow() { }

    // ── Binding ───────────────────────────────────────────────────────────────

    private void BindUI()
    {
        _promptInput  = _root.Q<TextField>("prompt-input");
        _submitBtn    = _root.Q<Button>("submit-btn");
        _submitIcon   = _root.Q<Label>("submit-icon");
        _resultBanner = _root.Q("result-banner");
        _resultIcon   = _root.Q<Label>("result-icon");
        _resultText   = _root.Q<Label>("result-text");

        _promptInput?.RegisterValueChangedCallback(e =>
        {
            bool empty = string.IsNullOrWhiteSpace(e.newValue);
            _submitBtn?.EnableInClassList("disabled", empty);
        });

        _submitBtn?.RegisterCallback<ClickEvent>(_ => Submit());

        _submitBtn?.AddToClassList("disabled");
    }

    // ── Submit ────────────────────────────────────────────────────────────────

    private void Submit()
    {
        var prompt = _promptInput?.value?.Trim() ?? "";
        if (string.IsNullOrEmpty(prompt)) return;

        SetBusy(true);
        _resultBanner?.AddToClassList("hidden");

        StartCoroutine(PludoApiClient.CreateLuauGame(prompt, "Player1",
            result =>
            {
                SetBusy(false);
                ShowResult(true, $"Created: {result?.title ?? "Game"}");
                if (_promptInput != null) _promptInput.value = "";
            },
            err =>
            {
                SetBusy(false);
                ShowResult(false, err ?? "Something went wrong");
                Debug.LogWarning($"[Create] error: {err}");
            },
            step =>
            {
                if (_submitIcon != null) _submitIcon.text = "⟳";
                ShowResult(true, step);
            }));
    }

    private void SetBusy(bool busy)
    {
        if (_submitBtn != null) _submitBtn.SetEnabled(!busy);
        if (_submitIcon != null) _submitIcon.text = busy ? "⟳" : "➤";
    }

    private void ShowResult(bool success, string message)
    {
        if (_resultBanner == null) return;

        _resultBanner.EnableInClassList("hidden",  false);
        _resultBanner.EnableInClassList("success", success);
        _resultBanner.EnableInClassList("error",   !success);

        if (_resultIcon != null) _resultIcon.text  = success ? "✔" : "⚠";
        if (_resultText != null) _resultText.text  = message;
    }
}
