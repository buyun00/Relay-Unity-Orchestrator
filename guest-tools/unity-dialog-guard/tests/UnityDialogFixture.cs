using System;
using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Threading;

namespace Relay.UnityDialogGuard.Tests
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            string mode = GetArgument(args, "--mode", "known");
            string output = GetArgument(args, "--output", null);
            string variant = GetArgument(args, "--variant", "42");
            if (String.IsNullOrWhiteSpace(output))
            {
                return 2;
            }

            Application application = new Application();
            Window window = BuildWindow(mode, output, variant);
            application.Run(window);
            return 0;
        }

        private static Window BuildWindow(
            string mode,
            string output,
            string variant)
        {
            bool known = String.Equals(
                mode,
                "known",
                StringComparison.OrdinalIgnoreCase);
            bool ai = String.Equals(
                mode,
                "ai",
                StringComparison.OrdinalIgnoreCase);
            Window window = new Window
            {
                Title = known
                    ? "UI Document was modified externally"
                    : ai
                        ? "Unknown AI Decision Notice"
                        : "Custom Import Notice",
                Width = 620,
                Height = 210,
                WindowStartupLocation = WindowStartupLocation.CenterScreen,
                ResizeMode = ResizeMode.NoResize,
                ShowInTaskbar = true,
                Topmost = true
            };

            Grid grid = new Grid
            {
                Margin = new Thickness(24)
            };
            grid.RowDefinitions.Add(new RowDefinition());
            grid.RowDefinitions.Add(new RowDefinition
            {
                Height = GridLength.Auto
            });

            TextBlock message = new TextBlock
            {
                Text = known
                    ? "UI Document was modified externally. Reload it from disk?"
                    : ai
                        ? "The import is paused and requires an operator decision."
                        : "A custom importer changed Example" + variant +
                            ".asset at C:\\Work\\Project" + variant +
                            "\\Assets\\Example" + variant + ".asset.",
                TextWrapping = TextWrapping.Wrap,
                FontSize = 15,
                VerticalAlignment = VerticalAlignment.Center
            };
            grid.Children.Add(message);

            StackPanel buttons = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Right
            };
            Grid.SetRow(buttons, 1);
            grid.Children.Add(buttons);

            if (known)
            {
                AddButton(buttons, window, output, "Reload");
                AddButton(buttons, window, output, "Ignore");
            }
            else if (ai)
            {
                AddButton(buttons, window, output, "Proceed Safely");
                AddButton(buttons, window, output, "Cancel");
            }
            else
            {
                AddButton(buttons, window, output, "Apply Now");
                AddButton(buttons, window, output, "Later");
            }

            window.Content = grid;
            return window;
        }

        private static void AddButton(
            Panel parent,
            Window window,
            string output,
            string text)
        {
            Button button = new Button
            {
                Content = text,
                Width = 96,
                Height = 30,
                Margin = new Thickness(8, 0, 0, 0)
            };
            AutomationProperties.SetName(button, text);
            button.Click += delegate
            {
                File.WriteAllText(output, text, new UTF8Encoding(false));
                DispatcherTimer closeTimer = new DispatcherTimer
                {
                    Interval = TimeSpan.FromMilliseconds(150)
                };
                closeTimer.Tick += delegate
                {
                    closeTimer.Stop();
                    window.Close();
                };
                closeTimer.Start();
            };
            parent.Children.Add(button);
        }

        private static string GetArgument(
            string[] args,
            string name,
            string defaultValue)
        {
            for (int index = 0; index < args.Length - 1; index++)
            {
                if (String.Equals(args[index], name, StringComparison.OrdinalIgnoreCase))
                {
                    return args[index + 1];
                }
            }
            return defaultValue;
        }
    }
}
