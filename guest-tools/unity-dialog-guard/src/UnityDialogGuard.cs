using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;

namespace Relay.UnityDialogGuard
{
    internal static class Program
    {
        [MTAThread]
        private static int Main(string[] args)
        {
            CommandLine options;
            try
            {
                options = CommandLine.Parse(args);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                return 2;
            }

            string baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
            string configPath = options.GetPath(
                "config",
                Path.Combine(baseDirectory, "config.json"));
            string learnedPath = options.GetPath(
                "learned",
                Path.Combine(baseDirectory, "learned-rules.json"));
            string logDirectory = options.GetPath(
                "log-dir",
                Path.Combine(baseDirectory, "logs"));

            GuardLogger logger = new GuardLogger(logDirectory);
            try
            {
                if (!Environment.UserInteractive)
                {
                    logger.Error(
                        "UnityDialogGuard must run in the same interactive desktop session as Unity.");
                    return 3;
                }

                using (SingleInstance singleInstance = new SingleInstance(options.Has("no-mutex")))
                {
                    if (!singleInstance.Acquired)
                    {
                        logger.Error(
                            "Another UnityDialogGuard instance is already running in this user session.");
                        return 4;
                    }

                    using (DialogGuard guard = new DialogGuard(
                        configPath,
                        learnedPath,
                        logger,
                        options.Has("verbose")))
                    {
                        logger.Event("guard.started", new Dictionary<string, object>
                        {
                            { "version", BuildInfo.Version },
                            { "sessionId", Process.GetCurrentProcess().SessionId },
                            { "configPath", configPath },
                            { "learnedRulesPath", learnedPath }
                        });

                        if (options.Has("once"))
                        {
                            guard.ScanOnce();
                        }
                        else
                        {
                            int runSeconds = options.GetInt("run-seconds", 0);
                            guard.Run(runSeconds);
                        }

                        logger.Event("guard.stopped", new Dictionary<string, object>());
                    }
                }

                return 0;
            }
            catch (Exception error)
            {
                logger.Error(error.ToString());
                return 1;
            }
        }
    }

    internal static class BuildInfo
    {
        public const string Version = "1.0.0";
    }

    internal sealed class CommandLine
    {
        private readonly Dictionary<string, string> _values =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public static CommandLine Parse(string[] args)
        {
            CommandLine result = new CommandLine();
            for (int index = 0; index < args.Length; index++)
            {
                string argument = args[index];
                if (!argument.StartsWith("--", StringComparison.Ordinal))
                {
                    throw new ArgumentException("Unexpected argument: " + argument);
                }

                string key = argument.Substring(2);
                string value = "true";
                if (index + 1 < args.Length &&
                    !args[index + 1].StartsWith("--", StringComparison.Ordinal))
                {
                    value = args[++index];
                }

                result._values[key] = value;
            }

            return result;
        }

        public bool Has(string key)
        {
            return _values.ContainsKey(key);
        }

        public string GetPath(string key, string defaultValue)
        {
            string value;
            if (!_values.TryGetValue(key, out value))
            {
                value = defaultValue;
            }

            return Path.GetFullPath(Environment.ExpandEnvironmentVariables(value));
        }

        public int GetInt(string key, int defaultValue)
        {
            string value;
            int parsed;
            if (!_values.TryGetValue(key, out value))
            {
                return defaultValue;
            }

            if (!int.TryParse(value, out parsed) || parsed < 0)
            {
                throw new ArgumentException("--" + key + " must be a non-negative integer.");
            }

            return parsed;
        }

    }

    internal sealed class SingleInstance : IDisposable
    {
        private readonly Mutex _mutex;

        public SingleInstance(bool disabled)
        {
            if (disabled)
            {
                Acquired = true;
                return;
            }

            string name = "Local\\Relay.UnityDialogGuard." +
                Process.GetCurrentProcess().SessionId;
            bool created;
            _mutex = new Mutex(true, name, out created);
            Acquired = created;
        }

        public bool Acquired { get; private set; }

        public void Dispose()
        {
            if (_mutex == null)
            {
                return;
            }

            if (Acquired)
            {
                try
                {
                    _mutex.ReleaseMutex();
                }
                catch (ApplicationException)
                {
                }
            }

            _mutex.Dispose();
        }
    }

    public sealed class GuardConfig
    {
        public int schemaVersion { get; set; }
        public int pollIntervalMs { get; set; }
        public int initialActionDelayMs { get; set; }
        public bool autoLearn { get; set; }
        public bool captureUnknownDialogScreenshots { get; set; }
        public string[] unityProcessNames { get; set; }
        public DialogRule[] rules { get; set; }
    }

    public sealed class DialogRule
    {
        public string id { get; set; }
        public bool enabled { get; set; }
        public string titleRegex { get; set; }
        public string textRegex { get; set; }
        public string buttonRegex { get; set; }
        public string[] targetButtonNames { get; set; }
        public string targetButtonRegex { get; set; }
        public int delayMs { get; set; }
        public int maxAttemptsPerDialog { get; set; }
        public string source { get; set; }
        public string note { get; set; }
    }

    public sealed class LearnedRulesFile
    {
        public int schemaVersion { get; set; }
        public string updatedAt { get; set; }
        public List<LearnedRule> rules { get; set; }
    }

    public sealed class LearnedRule
    {
        public string id { get; set; }
        public bool enabled { get; set; }
        public string fingerprint { get; set; }
        public string canonicalTitle { get; set; }
        public string canonicalText { get; set; }
        public string[] buttonNames { get; set; }
        public string targetButtonName { get; set; }
        public string observedTitle { get; set; }
        public string observedText { get; set; }
        public string learnedAt { get; set; }
        public int useCount { get; set; }
        public string lastUsedAt { get; set; }
    }

    internal sealed class DialogGuard : IDisposable
    {
        private readonly string _configPath;
        private readonly string _learnedPath;
        private readonly GuardLogger _logger;
        private readonly bool _verbose;
        private readonly JavaScriptSerializer _serializer = new JavaScriptSerializer();
        private readonly object _sync = new object();
        private readonly Dictionary<string, DateTime> _firstSeen =
            new Dictionary<string, DateTime>(StringComparer.Ordinal);
        private readonly Dictionary<string, int> _attempts =
            new Dictionary<string, int>(StringComparer.Ordinal);
        private readonly Dictionary<string, ButtonContext> _buttonContexts =
            new Dictionary<string, ButtonContext>(StringComparer.Ordinal);
        private readonly Dictionary<string, DateTime> _programmaticInvocations =
            new Dictionary<string, DateTime>(StringComparer.Ordinal);
        private readonly HashSet<string> _unknownLogged =
            new HashSet<string>(StringComparer.Ordinal);
        private readonly AutomationEventHandler _invokedHandler;
        private readonly NativeInputMonitor _nativeInputMonitor;
        private GuardConfig _config;
        private LearnedRulesFile _learned;
        private DateTime _configWriteTime;
        private DateTime _learnedWriteTime;
        private DateTime _lastReloadCheck;
        private bool _disposed;

        public DialogGuard(
            string configPath,
            string learnedPath,
            GuardLogger logger,
            bool verbose)
        {
            _configPath = configPath;
            _learnedPath = learnedPath;
            _logger = logger;
            _verbose = verbose;
            LoadConfiguration(true);
            _invokedHandler = OnButtonInvoked;
            Automation.AddAutomationEventHandler(
                InvokePattern.InvokedEvent,
                AutomationElement.RootElement,
                TreeScope.Subtree,
                _invokedHandler);
            _nativeInputMonitor = new NativeInputMonitor(OnNativeInput, _logger);
        }

        public void Run(int runSeconds)
        {
            DateTime deadline = runSeconds > 0
                ? DateTime.UtcNow.AddSeconds(runSeconds)
                : DateTime.MaxValue;

            while (DateTime.UtcNow < deadline)
            {
                ScanOnce();
                Thread.Sleep(Math.Max(100, _config.pollIntervalMs));
            }
        }

        public void ScanOnce()
        {
            ReloadConfigurationIfChanged();
            List<DialogSnapshot> snapshots = WindowScanner.FindUnityWindows(_config, _logger);
            HashSet<int> activeHandles = new HashSet<int>();

            foreach (DialogSnapshot snapshot in snapshots)
            {
                activeHandles.Add(snapshot.Handle);
                RegisterButtonContexts(snapshot);
                DialogRule knownRule = FindKnownRule(snapshot);
                LearnedRule learnedRule = knownRule == null
                    ? FindLearnedRule(snapshot)
                    : null;

                if (knownRule != null)
                {
                    TryApplyKnownRule(snapshot, knownRule);
                    continue;
                }

                if (learnedRule != null)
                {
                    TryApplyLearnedRule(snapshot, learnedRule);
                    continue;
                }

                if (snapshot.IsLikelyDialog)
                {
                    RecordUnknown(snapshot);
                }
            }

            CleanupState(activeHandles);
        }

        private void ReloadConfigurationIfChanged()
        {
            if ((DateTime.UtcNow - _lastReloadCheck).TotalSeconds < 2)
            {
                return;
            }

            _lastReloadCheck = DateTime.UtcNow;
            DateTime configWriteTime = File.Exists(_configPath)
                ? File.GetLastWriteTimeUtc(_configPath)
                : DateTime.MinValue;
            DateTime learnedWriteTime = File.Exists(_learnedPath)
                ? File.GetLastWriteTimeUtc(_learnedPath)
                : DateTime.MinValue;
            if (configWriteTime != _configWriteTime ||
                learnedWriteTime != _learnedWriteTime)
            {
                LoadConfiguration(false);
            }
        }

        private void LoadConfiguration(bool initial)
        {
            if (!File.Exists(_configPath))
            {
                throw new FileNotFoundException(
                    "Unity dialog guard config file was not found.",
                    _configPath);
            }

            GuardConfig config = _serializer.Deserialize<GuardConfig>(
                File.ReadAllText(_configPath, Encoding.UTF8));
            if (config == null || config.schemaVersion != 1)
            {
                throw new InvalidDataException(
                    "config.json must use schemaVersion 1.");
            }

            if (config.pollIntervalMs < 100)
            {
                config.pollIntervalMs = 100;
            }
            if (config.initialActionDelayMs < 0)
            {
                config.initialActionDelayMs = 0;
            }
            if (config.unityProcessNames == null ||
                config.unityProcessNames.Length == 0)
            {
                config.unityProcessNames = new[] { "Unity" };
            }
            if (config.rules == null)
            {
                config.rules = new DialogRule[0];
            }

            ValidateRules(config.rules);
            LearnedRulesFile learned = LoadLearnedRules();

            lock (_sync)
            {
                _config = config;
                _learned = learned;
                _configWriteTime = File.GetLastWriteTimeUtc(_configPath);
                _learnedWriteTime = File.Exists(_learnedPath)
                    ? File.GetLastWriteTimeUtc(_learnedPath)
                    : DateTime.MinValue;
            }

            if (!initial)
            {
                _logger.Event("configuration.reloaded", new Dictionary<string, object>
                {
                    { "knownRuleCount", config.rules.Length },
                    { "learnedRuleCount", learned.rules.Count }
                });
            }
        }

        private LearnedRulesFile LoadLearnedRules()
        {
            if (!File.Exists(_learnedPath))
            {
                return new LearnedRulesFile
                {
                    schemaVersion = 1,
                    updatedAt = null,
                    rules = new List<LearnedRule>()
                };
            }

            LearnedRulesFile result = _serializer.Deserialize<LearnedRulesFile>(
                File.ReadAllText(_learnedPath, Encoding.UTF8));
            if (result == null || result.schemaVersion != 1)
            {
                throw new InvalidDataException(
                    "learned-rules.json must use schemaVersion 1.");
            }
            if (result.rules == null)
            {
                result.rules = new List<LearnedRule>();
            }
            return result;
        }

        private static void ValidateRules(IEnumerable<DialogRule> rules)
        {
            HashSet<string> ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (DialogRule rule in rules)
            {
                if (String.IsNullOrWhiteSpace(rule.id))
                {
                    throw new InvalidDataException("Every dialog rule requires an id.");
                }
                if (!ids.Add(rule.id))
                {
                    throw new InvalidDataException("Duplicate dialog rule id: " + rule.id);
                }
                ValidateRegex(rule.id, "titleRegex", rule.titleRegex);
                ValidateRegex(rule.id, "textRegex", rule.textRegex);
                ValidateRegex(rule.id, "buttonRegex", rule.buttonRegex);
                ValidateRegex(rule.id, "targetButtonRegex", rule.targetButtonRegex);
            }
        }

        private static void ValidateRegex(string id, string field, string pattern)
        {
            if (String.IsNullOrWhiteSpace(pattern))
            {
                return;
            }

            try
            {
                new Regex(pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            }
            catch (ArgumentException error)
            {
                throw new InvalidDataException(
                    "Rule '" + id + "' has an invalid " + field + ": " + error.Message);
            }
        }

        private DialogRule FindKnownRule(DialogSnapshot snapshot)
        {
            foreach (DialogRule rule in _config.rules)
            {
                if (!rule.enabled)
                {
                    continue;
                }
                if (!Matches(rule.titleRegex, snapshot.Title))
                {
                    continue;
                }
                if (!Matches(rule.textRegex, snapshot.SearchableText))
                {
                    continue;
                }
                if (!Matches(rule.buttonRegex, snapshot.ButtonSearchText))
                {
                    continue;
                }
                return rule;
            }
            return null;
        }

        private static bool Matches(string regex, string value)
        {
            return String.IsNullOrWhiteSpace(regex) ||
                Regex.IsMatch(
                    value ?? String.Empty,
                    regex,
                    RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        }

        private LearnedRule FindLearnedRule(DialogSnapshot snapshot)
        {
            lock (_sync)
            {
                return _learned.rules.FirstOrDefault(
                    rule => rule.enabled &&
                        String.Equals(
                            rule.fingerprint,
                            snapshot.Fingerprint,
                            StringComparison.Ordinal));
            }
        }

        private void TryApplyKnownRule(DialogSnapshot snapshot, DialogRule rule)
        {
            int delay = rule.delayMs > 0
                ? rule.delayMs
                : _config.initialActionDelayMs;
            int maximumAttempts = rule.maxAttemptsPerDialog > 0
                ? rule.maxAttemptsPerDialog
                : 1;
            string stateKey = snapshot.Handle + "|" + snapshot.Fingerprint + "|" + rule.id;
            if (!ReadyToAct(stateKey, delay, maximumAttempts))
            {
                return;
            }

            ButtonSnapshot target = FindTargetButton(
                snapshot,
                rule.targetButtonNames,
                rule.targetButtonRegex);
            if (target == null)
            {
                IncrementAttempt(stateKey);
                _logger.Event("rule.target-not-found", snapshot.ToLogRecord(
                    new Dictionary<string, object>
                    {
                        { "ruleId", rule.id },
                        { "targetButtonNames", rule.targetButtonNames ?? new string[0] },
                        { "targetButtonRegex", rule.targetButtonRegex }
                    }));
                RecordUnknown(snapshot);
                return;
            }

            InvokeButton(snapshot, target, "known", rule.id);
            IncrementAttempt(stateKey);
        }

        private void TryApplyLearnedRule(DialogSnapshot snapshot, LearnedRule rule)
        {
            string stateKey = snapshot.Handle + "|" + snapshot.Fingerprint + "|" + rule.id;
            if (!ReadyToAct(stateKey, _config.initialActionDelayMs, 1))
            {
                return;
            }

            ButtonSnapshot target = snapshot.Buttons.FirstOrDefault(
                button => String.Equals(
                    button.CanonicalName,
                    TextFingerprint.CanonicalButton(rule.targetButtonName),
                    StringComparison.Ordinal));
            if (target == null)
            {
                IncrementAttempt(stateKey);
                _logger.Event("learned-rule.target-not-found", snapshot.ToLogRecord(
                    new Dictionary<string, object>
                    {
                        { "ruleId", rule.id },
                        { "targetButtonName", rule.targetButtonName }
                    }));
                return;
            }

            bool invoked = InvokeButton(snapshot, target, "learned", rule.id);
            IncrementAttempt(stateKey);
            if (invoked)
            {
                lock (_sync)
                {
                    rule.useCount++;
                    rule.lastUsedAt = DateTime.UtcNow.ToString("o");
                    SaveLearnedRulesLocked();
                }
            }
        }

        private bool ReadyToAct(string stateKey, int delayMs, int maximumAttempts)
        {
            DateTime firstSeen;
            if (!_firstSeen.TryGetValue(stateKey, out firstSeen))
            {
                _firstSeen[stateKey] = DateTime.UtcNow;
                return delayMs == 0;
            }

            if ((DateTime.UtcNow - firstSeen).TotalMilliseconds < delayMs)
            {
                return false;
            }

            int attempts;
            _attempts.TryGetValue(stateKey, out attempts);
            return attempts < maximumAttempts;
        }

        private void IncrementAttempt(string stateKey)
        {
            int attempts;
            _attempts.TryGetValue(stateKey, out attempts);
            _attempts[stateKey] = attempts + 1;
        }

        private static ButtonSnapshot FindTargetButton(
            DialogSnapshot snapshot,
            string[] preferredNames,
            string targetRegex)
        {
            if (preferredNames != null)
            {
                foreach (string preferredName in preferredNames)
                {
                    string canonical = TextFingerprint.CanonicalButton(preferredName);
                    ButtonSnapshot exact = snapshot.Buttons.FirstOrDefault(
                        button => String.Equals(
                            button.CanonicalName,
                            canonical,
                            StringComparison.Ordinal));
                    if (exact != null)
                    {
                        return exact;
                    }
                }
            }

            if (!String.IsNullOrWhiteSpace(targetRegex))
            {
                return snapshot.Buttons.FirstOrDefault(
                    button => Regex.IsMatch(
                        button.Name ?? String.Empty,
                        targetRegex,
                        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant));
            }

            return null;
        }

        private bool InvokeButton(
            DialogSnapshot snapshot,
            ButtonSnapshot button,
            string ruleType,
            string ruleId)
        {
            lock (_sync)
            {
                _programmaticInvocations[button.RuntimeId] = DateTime.UtcNow;
                if (button.NativeHandle != IntPtr.Zero)
                {
                    _programmaticInvocations[
                        ButtonSnapshot.NativeKey(button.NativeHandle)] = DateTime.UtcNow;
                }
            }

            Exception failure = null;
            string method = null;
            object pattern;
            if (button.Element != null)
            {
                try
                {
                    if (button.Element.TryGetCurrentPattern(
                        InvokePattern.Pattern,
                        out pattern))
                    {
                        ((InvokePattern)pattern).Invoke();
                        method = "InvokePattern";
                    }
                }
                catch (Exception error)
                {
                    failure = error;
                }
            }

            if (method == null && button.NativeHandle != IntPtr.Zero)
            {
                try
                {
                    NativeMethods.SendMessage(
                        button.NativeHandle,
                        NativeMethods.BM_CLICK,
                        IntPtr.Zero,
                        IntPtr.Zero);
                    method = "BM_CLICK";
                    failure = null;
                }
                catch (Exception error)
                {
                    failure = error;
                }
            }

            if (method == null && failure == null)
            {
                failure = new InvalidOperationException(
                    "The target button exposes no supported invocation pattern.");
            }

            if (failure != null)
            {
                _logger.Event("dialog.action-failed", snapshot.ToLogRecord(
                    new Dictionary<string, object>
                    {
                        { "ruleType", ruleType },
                        { "ruleId", ruleId },
                        { "targetButton", button.Name },
                        { "error", failure.Message }
                    }));
                return false;
            }

            _logger.Event("dialog.action", snapshot.ToLogRecord(
                new Dictionary<string, object>
                {
                    { "ruleType", ruleType },
                    { "ruleId", ruleId },
                    { "targetButton", button.Name },
                    { "method", method }
                }));
            return true;
        }

        private void RegisterButtonContexts(DialogSnapshot snapshot)
        {
            lock (_sync)
            {
                foreach (ButtonSnapshot button in snapshot.Buttons)
                {
                    if (String.IsNullOrWhiteSpace(button.RuntimeId))
                    {
                        continue;
                    }
                    _buttonContexts[button.RuntimeId] = new ButtonContext
                    {
                        Snapshot = snapshot,
                        ButtonName = button.Name,
                        ObservedAt = DateTime.UtcNow
                    };
                    if (button.NativeHandle != IntPtr.Zero)
                    {
                        _buttonContexts[ButtonSnapshot.NativeKey(button.NativeHandle)] =
                            new ButtonContext
                            {
                                Snapshot = snapshot,
                                ButtonName = button.Name,
                                ObservedAt = DateTime.UtcNow
                            };
                    }
                }
            }
        }

        private void OnButtonInvoked(object sender, AutomationEventArgs eventArgs)
        {
            AutomationElement element = sender as AutomationElement;
            if (element == null)
            {
                return;
            }

            string runtimeId;
            try
            {
                runtimeId = ButtonSnapshot.RuntimeIdFor(element);
            }
            catch (ElementNotAvailableException)
            {
                return;
            }

            HandleManualActionKey(runtimeId);
        }

        private void OnNativeInput(
            string eventType,
            IntPtr nativeHandle,
            int screenX,
            int screenY)
        {
            List<string> keys = new List<string>();
            if (nativeHandle != IntPtr.Zero)
            {
                keys.Add(ButtonSnapshot.NativeKey(nativeHandle));
            }

            if (screenX != Int32.MinValue && screenY != Int32.MinValue)
            {
                try
                {
                    AutomationElement element = AutomationElement.FromPoint(
                        new System.Windows.Point(screenX, screenY));
                    if (element != null)
                    {
                        keys.Add(ButtonSnapshot.RuntimeIdFor(element));
                        int elementHandle = element.Current.NativeWindowHandle;
                        if (elementHandle != 0)
                        {
                            keys.Add(ButtonSnapshot.NativeKey(new IntPtr(elementHandle)));
                        }
                    }
                }
                catch (Exception)
                {
                }
            }

            foreach (string key in keys.Distinct(StringComparer.Ordinal))
            {
                if (HandleManualActionKey(key))
                {
                    return;
                }
            }
        }

        private bool HandleManualActionKey(string key)
        {
            if (String.IsNullOrWhiteSpace(key))
            {
                return false;
            }

            ButtonContext context;
            lock (_sync)
            {
                DateTime invokedAt;
                if (_programmaticInvocations.TryGetValue(key, out invokedAt) &&
                    (DateTime.UtcNow - invokedAt).TotalSeconds < 10)
                {
                    return true;
                }
                if (!_buttonContexts.TryGetValue(key, out context))
                {
                    return false;
                }
            }

            if (!_config.autoLearn || !context.Snapshot.IsLikelyDialog)
            {
                return true;
            }

            LearnManualAction(
                context.Snapshot,
                context.ButtonName,
                "interactive-input");
            return true;
        }

        private bool LearnManualAction(
            DialogSnapshot snapshot,
            string buttonName,
            string learningSource)
        {
            lock (_sync)
            {
                LearnedRule existing = _learned.rules.FirstOrDefault(
                    rule => String.Equals(
                        rule.fingerprint,
                        snapshot.Fingerprint,
                        StringComparison.Ordinal) &&
                        String.Equals(
                            TextFingerprint.CanonicalButton(rule.targetButtonName),
                            TextFingerprint.CanonicalButton(buttonName),
                            StringComparison.Ordinal));
                if (existing != null)
                {
                    return false;
                }

                LearnedRule learnedRule = new LearnedRule
                {
                    id = "learned-" + snapshot.Fingerprint.Substring(0, 12).ToLowerInvariant(),
                    enabled = true,
                    fingerprint = snapshot.Fingerprint,
                    canonicalTitle = snapshot.CanonicalTitle,
                    canonicalText = snapshot.CanonicalText,
                    buttonNames = snapshot.Buttons
                        .Select(button => button.Name)
                        .OrderBy(name => name, StringComparer.OrdinalIgnoreCase)
                        .ToArray(),
                    targetButtonName = buttonName,
                    observedTitle = snapshot.Title,
                    observedText = snapshot.CombinedText,
                    learnedAt = DateTime.UtcNow.ToString("o"),
                    useCount = 0,
                    lastUsedAt = null
                };
                _learned.rules.Add(learnedRule);
                SaveLearnedRulesLocked();

                _logger.Event("dialog.learned", snapshot.ToLogRecord(
                    new Dictionary<string, object>
                    {
                        { "ruleId", learnedRule.id },
                        { "targetButton", buttonName },
                        { "learningSource", learningSource },
                        { "learnedRulesPath", _learnedPath }
                    }));
                return true;
            }
        }

        private void SaveLearnedRulesLocked()
        {
            _learned.updatedAt = DateTime.UtcNow.ToString("o");
            string directory = Path.GetDirectoryName(_learnedPath);
            if (!String.IsNullOrWhiteSpace(directory))
            {
                Directory.CreateDirectory(directory);
            }

            string temporaryPath = _learnedPath + ".tmp";
            string json = _serializer.Serialize(_learned);
            File.WriteAllText(temporaryPath, JsonFormatting.Indent(json), new UTF8Encoding(false));
            if (File.Exists(_learnedPath))
            {
                string backupPath = _learnedPath + ".bak";
                File.Replace(temporaryPath, _learnedPath, backupPath, true);
                try
                {
                    File.Delete(backupPath);
                }
                catch (IOException)
                {
                }
            }
            else
            {
                File.Move(temporaryPath, _learnedPath);
            }
            _learnedWriteTime = File.GetLastWriteTimeUtc(_learnedPath);
        }

        private void RecordUnknown(DialogSnapshot snapshot)
        {
            string key = snapshot.Handle + "|" + snapshot.Fingerprint;
            if (!_unknownLogged.Add(key))
            {
                return;
            }

            string screenshot = null;
            if (_config.captureUnknownDialogScreenshots)
            {
                screenshot = CaptureScreenshot(snapshot);
            }

            _logger.Unknown(snapshot.ToLogRecord(
                new Dictionary<string, object>
                {
                    { "screenshot", screenshot },
                    { "instruction", "Click the desired button once; the guard will learn that action." }
                }));
        }

        private string CaptureScreenshot(DialogSnapshot snapshot)
        {
            if (snapshot.Bounds.Width <= 0 ||
                snapshot.Bounds.Height <= 0 ||
                snapshot.Bounds.Width > 10000 ||
                snapshot.Bounds.Height > 10000)
            {
                return null;
            }

            try
            {
                string fileName = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff") +
                    "-" + snapshot.Fingerprint.Substring(0, 12).ToLowerInvariant() + ".png";
                string path = _logger.ScreenshotPath(fileName);
                Rectangle bounds = new Rectangle(
                    (int)Math.Floor(snapshot.Bounds.X),
                    (int)Math.Floor(snapshot.Bounds.Y),
                    (int)Math.Ceiling(snapshot.Bounds.Width),
                    (int)Math.Ceiling(snapshot.Bounds.Height));
                using (Bitmap bitmap = new Bitmap(
                    Math.Max(1, bounds.Width),
                    Math.Max(1, bounds.Height)))
                using (Graphics graphics = Graphics.FromImage(bitmap))
                {
                    graphics.CopyFromScreen(
                        bounds.Left,
                        bounds.Top,
                        0,
                        0,
                        bounds.Size,
                        CopyPixelOperation.SourceCopy);
                    bitmap.Save(path, ImageFormat.Png);
                }
                return path;
            }
            catch (Exception error)
            {
                if (_verbose)
                {
                    _logger.Error("Unable to capture dialog screenshot: " + error.Message);
                }
                return null;
            }
        }

        private void CleanupState(HashSet<int> activeHandles)
        {
            string[] stateKeys = _firstSeen.Keys
                .Where(key =>
                {
                    int separator = key.IndexOf('|');
                    int handle;
                    return separator > 0 &&
                        int.TryParse(key.Substring(0, separator), out handle) &&
                        !activeHandles.Contains(handle);
                })
                .ToArray();
            foreach (string key in stateKeys)
            {
                _firstSeen.Remove(key);
                _attempts.Remove(key);
            }

            lock (_sync)
            {
                DateTime cutoff = DateTime.UtcNow.AddMinutes(-2);
                foreach (string key in _buttonContexts
                    .Where(pair => pair.Value.ObservedAt < cutoff)
                    .Select(pair => pair.Key)
                    .ToArray())
                {
                    _buttonContexts.Remove(key);
                }
                foreach (string key in _programmaticInvocations
                    .Where(pair => pair.Value < cutoff)
                    .Select(pair => pair.Key)
                    .ToArray())
                {
                    _programmaticInvocations.Remove(key);
                }
            }
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;
            Automation.RemoveAutomationEventHandler(
                InvokePattern.InvokedEvent,
                AutomationElement.RootElement,
                _invokedHandler);
            _nativeInputMonitor.Dispose();
        }
    }

    internal sealed class ButtonContext
    {
        public DialogSnapshot Snapshot { get; set; }
        public string ButtonName { get; set; }
        public DateTime ObservedAt { get; set; }
    }

    internal static class WindowScanner
    {
        public static List<DialogSnapshot> FindUnityWindows(
            GuardConfig config,
            GuardLogger logger)
        {
            List<DialogSnapshot> result = new List<DialogSnapshot>();
            HashSet<string> processNames = new HashSet<string>(
                config.unityProcessNames.Select(NormalizeProcessName),
                StringComparer.OrdinalIgnoreCase);
            AutomationElementCollection windows;
            try
            {
                windows = AutomationElement.RootElement.FindAll(
                    TreeScope.Children,
                    Condition.TrueCondition);
            }
            catch (Exception error)
            {
                logger.Error("Unable to enumerate desktop windows: " + error.Message);
                return result;
            }

            foreach (AutomationElement window in windows)
            {
                try
                {
                    int processId = window.Current.ProcessId;
                    if (processId <= 0)
                    {
                        continue;
                    }

                    string processName;
                    try
                    {
                        processName = Process.GetProcessById(processId).ProcessName;
                    }
                    catch (ArgumentException)
                    {
                        continue;
                    }
                    if (!processNames.Contains(NormalizeProcessName(processName)))
                    {
                        continue;
                    }

                    DialogSnapshot snapshot = DialogSnapshot.Create(
                        window,
                        processId,
                        processName);
                    if (snapshot != null)
                    {
                        result.Add(snapshot);
                    }
                }
                catch (ElementNotAvailableException)
                {
                }
                catch (InvalidOperationException)
                {
                }
                catch (COMException)
                {
                    // Unity dialogs can disappear between enumeration and a UIA
                    // property read. Treat that as a transient closed window.
                }
            }

            return result;
        }

        private static string NormalizeProcessName(string value)
        {
            string result = value ?? String.Empty;
            if (result.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            {
                result = result.Substring(0, result.Length - 4);
            }
            return result.Trim();
        }
    }

    internal sealed class DialogSnapshot
    {
        public AutomationElement Window { get; private set; }
        public int Handle { get; private set; }
        public int ProcessId { get; private set; }
        public string ProcessName { get; private set; }
        public string Title { get; private set; }
        public string ClassName { get; private set; }
        public bool IsModal { get; private set; }
        public bool HasOwner { get; private set; }
        public Rect Bounds { get; private set; }
        public List<string> Texts { get; private set; }
        public List<ButtonSnapshot> Buttons { get; private set; }
        public string CombinedText { get; private set; }
        public string SearchableText { get; private set; }
        public string ButtonSearchText { get; private set; }
        public string CanonicalTitle { get; private set; }
        public string CanonicalText { get; private set; }
        public string Fingerprint { get; private set; }
        public bool IsLikelyDialog { get; private set; }

        public static DialogSnapshot Create(
            AutomationElement window,
            int processId,
            string processName)
        {
            int handle = window.Current.NativeWindowHandle;
            if (handle == 0)
            {
                return null;
            }

            DialogSnapshot result = new DialogSnapshot
            {
                Window = window,
                Handle = handle,
                ProcessId = processId,
                ProcessName = processName,
                Title = SafeProperty(delegate { return window.Current.Name; }),
                ClassName = SafeProperty(delegate { return window.Current.ClassName; }),
                Bounds = SafeRect(window),
                Texts = new List<string>(),
                Buttons = new List<ButtonSnapshot>()
            };

            object pattern;
            if (window.TryGetCurrentPattern(WindowPattern.Pattern, out pattern))
            {
                try
                {
                    result.IsModal = ((WindowPattern)pattern).Current.IsModal;
                }
                catch (ElementNotAvailableException)
                {
                }
            }
            result.HasOwner = NativeMethods.GetWindow(
                new IntPtr(handle),
                NativeMethods.GW_OWNER) != IntPtr.Zero;

            AutomationElementCollection descendants = window.FindAll(
                TreeScope.Descendants,
                Condition.TrueCondition);
            HashSet<string> textSet = new HashSet<string>(
                StringComparer.OrdinalIgnoreCase);
            HashSet<string> buttonIds = new HashSet<string>(
                StringComparer.Ordinal);
            for (int index = 0; index < descendants.Count && index < 500; index++)
            {
                AutomationElement element = descendants[index];
                ControlType controlType;
                try
                {
                    controlType = element.Current.ControlType;
                }
                catch (ElementNotAvailableException)
                {
                    continue;
                }

                if (controlType == ControlType.Button)
                {
                    ButtonSnapshot button = ButtonSnapshot.FromAutomationElement(element);
                    if (button != null && buttonIds.Add(button.RuntimeId))
                    {
                        result.Buttons.Add(button);
                    }
                    continue;
                }

                if (controlType == ControlType.Text ||
                    controlType == ControlType.Document ||
                    controlType == ControlType.Edit ||
                    controlType == ControlType.Group)
                {
                    string text = SafeProperty(delegate { return element.Current.Name; });
                    if (!String.IsNullOrWhiteSpace(text) && textSet.Add(text.Trim()))
                    {
                        result.Texts.Add(text.Trim());
                    }
                }
            }

            NativeMethods.AddNativeControls(
                new IntPtr(handle),
                result.Texts,
                result.Buttons,
                textSet,
                buttonIds);

            result.CombinedText = String.Join(" | ", result.Texts.Take(100).ToArray());
            result.SearchableText = result.Title + " | " + result.CombinedText;
            result.ButtonSearchText = String.Join(
                " | ",
                result.Buttons.Select(button => button.Name).ToArray());
            result.CanonicalTitle = TextFingerprint.Canonicalize(result.Title);
            result.CanonicalText = TextFingerprint.CanonicalizeFragments(result.Texts);
            result.Fingerprint = TextFingerprint.For(result);
            result.IsLikelyDialog =
                result.IsModal ||
                result.HasOwner ||
                String.Equals(result.ClassName, "#32770", StringComparison.Ordinal) ||
                (result.Buttons.Count > 0 &&
                    result.Buttons.Count <= 8 &&
                    Regex.IsMatch(
                        result.Title ?? String.Empty,
                        "(dialog|warning|error|notice|reload|safe mode|consent|update|required|modified|Unity)",
                        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant));
            return result;
        }

        public Dictionary<string, object> ToLogRecord(
            Dictionary<string, object> additional)
        {
            Dictionary<string, object> record = new Dictionary<string, object>
            {
                { "fingerprint", Fingerprint },
                { "processId", ProcessId },
                { "processName", ProcessName },
                { "windowHandle", Handle },
                { "windowTitle", Title },
                { "windowClass", ClassName },
                { "isModal", IsModal },
                { "hasOwner", HasOwner },
                { "text", CombinedText },
                { "buttons", Buttons.Select(button => button.Name).ToArray() }
            };
            if (additional != null)
            {
                foreach (KeyValuePair<string, object> pair in additional)
                {
                    record[pair.Key] = pair.Value;
                }
            }
            return record;
        }

        private static string SafeProperty(Func<string> getter)
        {
            try
            {
                return getter() ?? String.Empty;
            }
            catch (ElementNotAvailableException)
            {
                return String.Empty;
            }
        }

        private static Rect SafeRect(AutomationElement element)
        {
            try
            {
                return element.Current.BoundingRectangle;
            }
            catch (ElementNotAvailableException)
            {
                return Rect.Empty;
            }
        }
    }

    internal sealed class ButtonSnapshot
    {
        public string Name { get; private set; }
        public string CanonicalName { get; private set; }
        public string RuntimeId { get; private set; }
        public AutomationElement Element { get; private set; }
        public IntPtr NativeHandle { get; private set; }

        public static ButtonSnapshot FromAutomationElement(AutomationElement element)
        {
            string runtimeId = RuntimeIdFor(element);
            if (String.IsNullOrWhiteSpace(runtimeId))
            {
                return null;
            }
            string name = element.Current.Name ?? String.Empty;
            return new ButtonSnapshot
            {
                Name = name.Trim(),
                CanonicalName = TextFingerprint.CanonicalButton(name),
                RuntimeId = runtimeId,
                Element = element,
                NativeHandle = new IntPtr(element.Current.NativeWindowHandle)
            };
        }

        public static ButtonSnapshot FromNative(
            IntPtr handle,
            string name,
            AutomationElement element)
        {
            string runtimeId = element != null
                ? RuntimeIdFor(element)
                : "hwnd:" + handle.ToInt64();
            return new ButtonSnapshot
            {
                Name = (name ?? String.Empty).Trim(),
                CanonicalName = TextFingerprint.CanonicalButton(name),
                RuntimeId = runtimeId,
                Element = element,
                NativeHandle = handle
            };
        }

        public static string RuntimeIdFor(AutomationElement element)
        {
            int[] parts = element.GetRuntimeId();
            return parts == null
                ? String.Empty
                : String.Join(".", parts.Select(value => value.ToString()).ToArray());
        }

        public static string NativeKey(IntPtr handle)
        {
            return "hwnd:" + handle.ToInt64();
        }
    }

    internal sealed class NativeInputMonitor : IDisposable
    {
        private readonly Action<string, IntPtr, int, int> _callback;
        private readonly GuardLogger _logger;
        private readonly Thread _thread;
        private readonly ManualResetEvent _started = new ManualResetEvent(false);
        private NativeMethods.WinEventDelegate _winEventDelegate;
        private NativeMethods.HookDelegate _mouseDelegate;
        private NativeMethods.HookDelegate _keyboardDelegate;
        private IntPtr _winEventHook;
        private IntPtr _mouseHook;
        private IntPtr _keyboardHook;
        private uint _threadId;
        private bool _disposed;

        public NativeInputMonitor(
            Action<string, IntPtr, int, int> callback,
            GuardLogger logger)
        {
            _callback = callback;
            _logger = logger;
            _thread = new Thread(Run);
            _thread.IsBackground = true;
            _thread.Name = "UnityDialogGuard.NativeInput";
            _thread.SetApartmentState(ApartmentState.MTA);
            _thread.Start();
            if (!_started.WaitOne(5000))
            {
                throw new InvalidOperationException(
                    "Native input monitor did not start within five seconds.");
            }
        }

        private void Run()
        {
            try
            {
                _threadId = NativeMethods.GetCurrentThreadId();
                _winEventDelegate = OnWinEvent;
                _mouseDelegate = OnMouse;
                _keyboardDelegate = OnKeyboard;
                _winEventHook = NativeMethods.SetWinEventHook(
                    NativeMethods.EVENT_OBJECT_INVOKED,
                    NativeMethods.EVENT_OBJECT_INVOKED,
                    IntPtr.Zero,
                    _winEventDelegate,
                    0,
                    0,
                    NativeMethods.WINEVENT_OUTOFCONTEXT);
                _mouseHook = NativeMethods.SetWindowsHookEx(
                    NativeMethods.WH_MOUSE_LL,
                    _mouseDelegate,
                    NativeMethods.GetModuleHandle(null),
                    0);
                _keyboardHook = NativeMethods.SetWindowsHookEx(
                    NativeMethods.WH_KEYBOARD_LL,
                    _keyboardDelegate,
                    NativeMethods.GetModuleHandle(null),
                    0);
                _logger.Event("native-monitor.started", new Dictionary<string, object>
                {
                    { "winEventHook", _winEventHook.ToInt64() },
                    { "mouseHook", _mouseHook.ToInt64() },
                    { "keyboardHook", _keyboardHook.ToInt64() },
                    { "lastWin32Error", Marshal.GetLastWin32Error() }
                });
                _started.Set();

                NativeMethods.Message message;
                while (NativeMethods.GetMessage(
                    out message,
                    IntPtr.Zero,
                    0,
                    0) > 0)
                {
                    NativeMethods.TranslateMessage(ref message);
                    NativeMethods.DispatchMessage(ref message);
                }
            }
            catch (Exception error)
            {
                _logger.Error("Native input monitor failed: " + error);
                _started.Set();
            }
            finally
            {
                if (_winEventHook != IntPtr.Zero)
                {
                    NativeMethods.UnhookWinEvent(_winEventHook);
                }
                if (_mouseHook != IntPtr.Zero)
                {
                    NativeMethods.UnhookWindowsHookEx(_mouseHook);
                }
                if (_keyboardHook != IntPtr.Zero)
                {
                    NativeMethods.UnhookWindowsHookEx(_keyboardHook);
                }
            }
        }

        private void OnWinEvent(
            IntPtr hook,
            uint eventType,
            IntPtr handle,
            int objectId,
            int childId,
            uint eventThread,
            uint eventTime)
        {
            _logger.Event("native-monitor.invoked", new Dictionary<string, object>
            {
                { "windowHandle", handle.ToInt64() },
                { "objectId", objectId },
                { "childId", childId }
            });
            Queue("accessibility-invoked", handle, Int32.MinValue, Int32.MinValue);
        }

        private IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0 && wParam.ToInt64() == NativeMethods.WM_LBUTTONUP)
            {
                NativeMethods.LowLevelMouse data =
                    (NativeMethods.LowLevelMouse)Marshal.PtrToStructure(
                        lParam,
                        typeof(NativeMethods.LowLevelMouse));
                IntPtr handle = NativeMethods.WindowFromPoint(data.point);
                Queue("mouse-click", handle, data.point.x, data.point.y);
            }
            return NativeMethods.CallNextHookEx(_mouseHook, code, wParam, lParam);
        }

        private IntPtr OnKeyboard(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0 &&
                (wParam.ToInt64() == NativeMethods.WM_KEYDOWN ||
                 wParam.ToInt64() == NativeMethods.WM_SYSKEYDOWN))
            {
                NativeMethods.LowLevelKeyboard data =
                    (NativeMethods.LowLevelKeyboard)Marshal.PtrToStructure(
                        lParam,
                        typeof(NativeMethods.LowLevelKeyboard));
                if (data.virtualKey == NativeMethods.VK_RETURN ||
                    data.virtualKey == NativeMethods.VK_SPACE)
                {
                    NativeMethods.GuiThreadInfo info =
                        NativeMethods.GuiThreadInfo.Create();
                    IntPtr handle = NativeMethods.GetGUIThreadInfo(0, ref info)
                        ? info.focus
                        : IntPtr.Zero;
                    Queue("keyboard-activate", handle, Int32.MinValue, Int32.MinValue);
                }
            }
            return NativeMethods.CallNextHookEx(_keyboardHook, code, wParam, lParam);
        }

        private void Queue(
            string eventType,
            IntPtr handle,
            int screenX,
            int screenY)
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    _callback(eventType, handle, screenX, screenY);
                }
                catch (Exception error)
                {
                    _logger.Error(
                        "Unable to process native input event '" +
                        eventType + "': " + error.Message);
                }
            });
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;
            if (_threadId != 0)
            {
                NativeMethods.PostThreadMessage(
                    _threadId,
                    NativeMethods.WM_QUIT,
                    IntPtr.Zero,
                    IntPtr.Zero);
            }
            _thread.Join(3000);
            _started.Dispose();
        }
    }

    internal static class TextFingerprint
    {
        private static readonly Regex WindowsPath = new Regex(
            @"(?i)(?:[a-z]:\\|\\\\)[^|""\r\n]+",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex AssetFile = new Regex(
            @"(?i)\b[\w .()\-]+\.(?:cs|unity|prefab|asset|uxml|uss|asmdef|asmref|dll|json|shader|mat|meta)\b",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex Guid = new Regex(
            @"(?i)\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b[0-9a-f]{32}\b",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex Number = new Regex(
            @"\b\d+(?:\.\d+)*\b",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex Whitespace = new Regex(
            @"\s+",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        public static string Canonicalize(string value)
        {
            string result = (value ?? String.Empty).Trim().ToLowerInvariant();
            result = WindowsPath.Replace(result, "<path>");
            result = AssetFile.Replace(result, "<file>");
            result = Guid.Replace(result, "<guid>");
            result = Number.Replace(result, "<number>");
            result = Whitespace.Replace(result, " ");
            return result.Trim();
        }

        public static string CanonicalButton(string value)
        {
            string result = Canonicalize(value);
            result = result.Replace("&", String.Empty);
            result = result.Replace("_", String.Empty);
            result = result.Trim('.', ' ', '\t');
            return result;
        }

        public static string CanonicalizeFragments(IEnumerable<string> values)
        {
            return String.Join(
                "\n",
                values
                    .Select(Canonicalize)
                    .Where(value => !String.IsNullOrWhiteSpace(value))
                    .Distinct(StringComparer.Ordinal)
                    .OrderBy(value => value, StringComparer.Ordinal)
                    .ToArray());
        }

        public static string For(DialogSnapshot snapshot)
        {
            string buttons = String.Join(
                "\n",
                snapshot.Buttons
                    .Select(button => button.CanonicalName)
                    .OrderBy(value => value, StringComparer.Ordinal)
                    .ToArray());
            string fingerprintInput = snapshot.CanonicalTitle + "\n" +
                snapshot.CanonicalText + "\n" + buttons;
            using (SHA256 sha = SHA256.Create())
            {
                return BitConverter.ToString(
                    sha.ComputeHash(Encoding.UTF8.GetBytes(fingerprintInput)))
                    .Replace("-", String.Empty);
            }
        }
    }

    internal sealed class GuardLogger
    {
        private readonly string _directory;
        private readonly JavaScriptSerializer _serializer = new JavaScriptSerializer();
        private readonly object _sync = new object();

        public GuardLogger(string directory)
        {
            _directory = directory;
            Directory.CreateDirectory(_directory);
            Directory.CreateDirectory(Path.Combine(_directory, "screenshots"));
        }

        public void Event(string type, Dictionary<string, object> data)
        {
            Dictionary<string, object> record = new Dictionary<string, object>
            {
                { "timestamp", DateTime.UtcNow.ToString("o") },
                { "type", type }
            };
            foreach (KeyValuePair<string, object> pair in data)
            {
                record[pair.Key] = pair.Value;
            }
            Append("actions.jsonl", _serializer.Serialize(record));
        }

        public void Unknown(Dictionary<string, object> data)
        {
            Dictionary<string, object> record = new Dictionary<string, object>
            {
                { "timestamp", DateTime.UtcNow.ToString("o") },
                { "type", "dialog.unknown" }
            };
            foreach (KeyValuePair<string, object> pair in data)
            {
                record[pair.Key] = pair.Value;
            }
            Append("unknown-dialogs.jsonl", _serializer.Serialize(record));
        }

        public void Error(string message)
        {
            Append(
                "errors.log",
                DateTime.UtcNow.ToString("o") + " " + message.Replace("\r", " ").Replace("\n", " "));
        }

        public string ScreenshotPath(string fileName)
        {
            return Path.Combine(_directory, "screenshots", fileName);
        }

        private void Append(string fileName, string line)
        {
            lock (_sync)
            {
                File.AppendAllText(
                    Path.Combine(_directory, fileName),
                    line + Environment.NewLine,
                    new UTF8Encoding(false));
            }
        }
    }

    internal static class JsonFormatting
    {
        public static string Indent(string json)
        {
            StringBuilder output = new StringBuilder();
            bool quoted = false;
            bool escaped = false;
            int depth = 0;
            for (int index = 0; index < json.Length; index++)
            {
                char current = json[index];
                if (quoted)
                {
                    output.Append(current);
                    if (escaped)
                    {
                        escaped = false;
                    }
                    else if (current == '\\')
                    {
                        escaped = true;
                    }
                    else if (current == '"')
                    {
                        quoted = false;
                    }
                    continue;
                }

                if (current == '"')
                {
                    quoted = true;
                    output.Append(current);
                }
                else if (current == '{' || current == '[')
                {
                    output.Append(current);
                    output.AppendLine();
                    depth++;
                    output.Append(new string(' ', depth * 2));
                }
                else if (current == '}' || current == ']')
                {
                    output.AppendLine();
                    depth--;
                    output.Append(new string(' ', depth * 2));
                    output.Append(current);
                }
                else if (current == ',')
                {
                    output.Append(current);
                    output.AppendLine();
                    output.Append(new string(' ', depth * 2));
                }
                else if (current == ':')
                {
                    output.Append(": ");
                }
                else
                {
                    output.Append(current);
                }
            }
            return output.ToString();
        }
    }

    internal static class NativeMethods
    {
        public const uint GW_OWNER = 4;
        public const uint BM_CLICK = 0x00F5;
        public const uint EVENT_OBJECT_INVOKED = 0x8013;
        public const uint WINEVENT_OUTOFCONTEXT = 0x0000;
        public const int WH_MOUSE_LL = 14;
        public const int WH_KEYBOARD_LL = 13;
        public const long WM_LBUTTONUP = 0x0202;
        public const long WM_KEYDOWN = 0x0100;
        public const long WM_SYSKEYDOWN = 0x0104;
        public const uint WM_QUIT = 0x0012;
        public const uint VK_RETURN = 0x0D;
        public const uint VK_SPACE = 0x20;

        private delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter);
        public delegate void WinEventDelegate(
            IntPtr hook,
            uint eventType,
            IntPtr handle,
            int objectId,
            int childId,
            uint eventThread,
            uint eventTime);
        public delegate IntPtr HookDelegate(int code, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        public struct NativePoint
        {
            public int x;
            public int y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct LowLevelMouse
        {
            public NativePoint point;
            public uint mouseData;
            public uint flags;
            public uint time;
            public IntPtr extraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct LowLevelKeyboard
        {
            public uint virtualKey;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr extraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct Message
        {
            public IntPtr window;
            public uint message;
            public IntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public NativePoint point;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct GuiThreadInfo
        {
            public int size;
            public int flags;
            public IntPtr active;
            public IntPtr focus;
            public IntPtr capture;
            public IntPtr menuOwner;
            public IntPtr moveSize;
            public IntPtr caret;
            public RectNative caretRectangle;

            public static GuiThreadInfo Create()
            {
                GuiThreadInfo result = new GuiThreadInfo();
                result.size = Marshal.SizeOf(typeof(GuiThreadInfo));
                return result;
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RectNative
        {
            public int left;
            public int top;
            public int right;
            public int bottom;
        }

        [DllImport("user32.dll")]
        public static extern IntPtr GetWindow(IntPtr handle, uint command);

        [DllImport("user32.dll")]
        public static extern IntPtr SendMessage(
            IntPtr handle,
            uint message,
            IntPtr wParam,
            IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWinEventHook(
            uint eventMinimum,
            uint eventMaximum,
            IntPtr module,
            WinEventDelegate callback,
            uint processId,
            uint threadId,
            uint flags);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool UnhookWinEvent(IntPtr hook);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(
            int hookId,
            HookDelegate callback,
            IntPtr module,
            uint threadId);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool UnhookWindowsHookEx(IntPtr hook);

        [DllImport("user32.dll")]
        public static extern IntPtr CallNextHookEx(
            IntPtr hook,
            int code,
            IntPtr wParam,
            IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern int GetMessage(
            out Message message,
            IntPtr window,
            uint minimum,
            uint maximum);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool TranslateMessage(ref Message message);

        [DllImport("user32.dll")]
        public static extern IntPtr DispatchMessage(ref Message message);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool PostThreadMessage(
            uint threadId,
            uint message,
            IntPtr wParam,
            IntPtr lParam);

        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr GetModuleHandle(string moduleName);

        [DllImport("user32.dll")]
        public static extern IntPtr WindowFromPoint(NativePoint point);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetGUIThreadInfo(
            uint threadId,
            ref GuiThreadInfo info);

        [DllImport("user32.dll")]
        private static extern bool EnumChildWindows(
            IntPtr parent,
            EnumWindowsProc callback,
            IntPtr parameter);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(
            IntPtr handle,
            StringBuilder className,
            int maximumCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(
            IntPtr handle,
            StringBuilder text,
            int maximumCount);

        public static void AddNativeControls(
            IntPtr window,
            List<string> texts,
            List<ButtonSnapshot> buttons,
            HashSet<string> textSet,
            HashSet<string> buttonIds)
        {
            EnumChildWindows(window, delegate(IntPtr handle, IntPtr parameter)
            {
                string className = ReadClassName(handle);
                string text = ReadWindowText(handle);
                if (String.Equals(className, "Button", StringComparison.OrdinalIgnoreCase))
                {
                    AutomationElement element = null;
                    try
                    {
                        element = AutomationElement.FromHandle(handle);
                    }
                    catch (Exception)
                    {
                    }
                    ButtonSnapshot button = ButtonSnapshot.FromNative(handle, text, element);
                    if (buttonIds.Add(button.RuntimeId))
                    {
                        buttons.Add(button);
                    }
                }
                else if (String.Equals(className, "Static", StringComparison.OrdinalIgnoreCase) &&
                    !String.IsNullOrWhiteSpace(text) &&
                    textSet.Add(text.Trim()))
                {
                    texts.Add(text.Trim());
                }
                return true;
            }, IntPtr.Zero);
        }

        private static string ReadClassName(IntPtr handle)
        {
            StringBuilder buffer = new StringBuilder(256);
            GetClassName(handle, buffer, buffer.Capacity);
            return buffer.ToString();
        }

        private static string ReadWindowText(IntPtr handle)
        {
            StringBuilder buffer = new StringBuilder(4096);
            GetWindowText(handle, buffer, buffer.Capacity);
            return buffer.ToString();
        }
    }
}
