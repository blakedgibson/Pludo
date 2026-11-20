using UnityEngine;
using UnityEngine.UIElements;

public class ForgeScreenController : MonoBehaviour
{
    private static readonly string[] GameExamples =
    {
        "Neon cyberpunk runner", "Dungeon crawler RPG", "Space invaders remix",
        "Tower defense with pets", "Puzzle platformer"
    };

    private static readonly string[] ItemExamples =
    {
        "Glowing dragon wings", "Cyber visor helmet", "Rainbow halo",
        "Samurai armor set", "Holographic cape"
    };

    private VisualElement     _root;
    private MainAppController _app;
    private VisualElement     _container;
    private VisualTreeAsset   _asset;

    private VisualElement _forgeRoot;
    private Button        _modeGame, _modeItem;
    private TextField     _creatorField, _promptField;
    private Label         _promptLabel, _charCount, _forgeBtnLabel;
    private Button        _forgeBtn;
    private VisualElement _examplesWrap;
    private VisualElement _resultBox, _errorBox;
    private Label         _resultText, _errorText;

    private bool _isGameMode = true;

    public void Setup(VisualTreeAsset asset, VisualElement container, MainAppController app)
    {
        _asset     = asset;
        _container = container;
        _app       = app;
    }

    public void OpenForge()
    {
        if (_forgeRoot == null)
        {
            _forgeRoot = _asset.CloneTree();
            _forgeRoot.style.display  = DisplayStyle.Flex;
            _forgeRoot.style.flexGrow = 1;
            _forgeRoot.style.position = Position.Absolute;
            _forgeRoot.style.left  = 0; _forgeRoot.style.right  = 0;
            _forgeRoot.style.top   = 0; _forgeRoot.style.bottom = 0;
            _container.Add(_forgeRoot);
            BindUI();
            SwitchMode(true);
        }
        _forgeRoot.SetDisplayed(true);
    }

    public void CloseForge() => _forgeRoot?.SetDisplayed(false);

    // ── Binding ───────────────────────────────────────────────────────────────

    private void BindUI()
    {
        _modeGame      = _forgeRoot.Q<Button>("mode-game");
        _modeItem      = _forgeRoot.Q<Button>("mode-item");
        _creatorField  = _forgeRoot.Q<TextField>("creator-field");
        _promptField   = _forgeRoot.Q<TextField>("prompt-field");
        _promptLabel   = _forgeRoot.Q<Label>("prompt-label");
        _charCount     = _forgeRoot.Q<Label>("char-count");
        _forgeBtnLabel = _forgeRoot.Q<Label>("forge-btn-label");
        _forgeBtn      = _forgeRoot.Q<Button>("forge-btn");
        _examplesWrap  = _forgeRoot.Q("examples-wrap");
        _resultBox     = _forgeRoot.Q("result-box");
        _errorBox      = _forgeRoot.Q("error-box");
        _resultText    = _forgeRoot.Q<Label>("result-text");
        _errorText     = _forgeRoot.Q<Label>("error-text");

        _modeGame?.RegisterCallback<ClickEvent>(_ => SwitchMode(true));
        _modeItem?.RegisterCallback<ClickEvent>(_ => SwitchMode(false));

        _promptField?.RegisterValueChangedCallback(e =>
        {
            int len = e.newValue?.Length ?? 0;
            if (_charCount != null) _charCount.text = $"{len}/500";
            _forgeBtn?.EnableInClassList("disabled", len == 0);
        });

        _forgeBtn?.RegisterCallback<ClickEvent>(_ => Forge());
        _forgeBtn?.AddToClassList("disabled");
    }

    // ── Mode toggle ───────────────────────────────────────────────────────────

    private void SwitchMode(bool gameMode)
    {
        _isGameMode = gameMode;

        _modeGame?.EnableInClassList("mode-active", gameMode);
        _modeItem?.EnableInClassList("mode-active", !gameMode);

        if (_promptLabel   != null) _promptLabel.text   = gameMode ? "Describe your game"       : "Describe your item";
        if (_forgeBtnLabel != null) _forgeBtnLabel.text = gameMode ? "Forge Game"               : "Forge Item";
        if (_promptField != null) _promptField.value = "";

        _resultBox?.AddToClassList("hidden");
        _errorBox?.AddToClassList("hidden");

        BuildExamples(gameMode ? GameExamples : ItemExamples);
    }

    private void BuildExamples(string[] examples)
    {
        if (_examplesWrap == null) return;
        _examplesWrap.Clear();
        foreach (var ex in examples)
        {
            var chip = new Button();
            chip.AddToClassList("example-chip");
            var lbl = new Label(ex);
            lbl.AddToClassList("example-chip-text");
            chip.Add(lbl);
            var captured = ex;
            chip.clicked += () =>
            {
                if (_promptField != null) _promptField.value = captured;
            };
            _examplesWrap.Add(chip);
        }
    }

    // ── Forge ─────────────────────────────────────────────────────────────────

    private void Forge()
    {
        var prompt  = _promptField?.value?.Trim() ?? "";
        var creator = _creatorField?.value?.Trim() ?? "Player1";
        if (string.IsNullOrEmpty(prompt)) return;

        SetBusy(true, "Forging...");
        _resultBox?.AddToClassList("hidden");
        _errorBox?.AddToClassList("hidden");

        if (_isGameMode)
        {
            StartCoroutine(PludoApiClient.CreateLuauGame(prompt, creator,
                result =>
                {
                    SetBusy(false);
                    ShowResult(true, $"Game created: {result?.title ?? "New Game"}");
                },
                err => { SetBusy(false); ShowResult(false, err ?? "Failed to forge game"); },
                step => SetBusy(true, step)));
        }
        else
        {
            StartCoroutine(PludoApiClient.CreateAvatarItem(prompt, creator,
                result =>
                {
                    SetBusy(false);
                    ShowResult(true, $"Item created: {result?.name ?? "New Item"}");
                },
                err => { SetBusy(false); ShowResult(false, err ?? "Failed to forge item"); }));
        }
    }

    private void SetBusy(bool busy, string progressLabel = null)
    {
        if (_forgeBtn   != null) _forgeBtn.SetEnabled(!busy);
        if (_forgeBtnLabel != null)
        {
            if (busy && progressLabel != null)
                _forgeBtnLabel.text = progressLabel;
            else
                _forgeBtnLabel.text = _isGameMode ? "Forge Game" : "Forge Item";
        }
    }

    private void ShowResult(bool success, string message)
    {
        if (success)
        {
            _resultBox?.RemoveFromClassList("hidden");
            if (_resultText != null) _resultText.text = message;
            if (_promptField != null) _promptField.value = "";
        }
        else
        {
            _errorBox?.RemoveFromClassList("hidden");
            if (_errorText != null) _errorText.text = message;
        }
    }
}
