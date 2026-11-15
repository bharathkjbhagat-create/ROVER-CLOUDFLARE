"""Static audit: every <button> on the dashboard must be wired to real code.

A button with an id must have that id referenced by some script; a button driven by a data-attribute
(data-scroll, data-action, data-cmd, ...) must have that attribute handled by some script.  This catches dead
controls (a button that does nothing).  Real-browser behaviour of the controls is covered by the browser_* tests."""
import re
import unittest
from pathlib import Path

PUBLIC = Path(__file__).resolve().parents[1] / "public"
SKIP_JS = ("sim-lab.js", "sim-core.js", "sim-lab-loader.js")


class ButtonAudit(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (PUBLIC / "index.html").read_text(encoding="utf-8")
        cls.js = "".join(p.read_text(encoding="utf-8") for p in PUBLIC.glob("*.js") if p.name not in SKIP_JS)
        cls.buttons = re.findall(r"<button\b([^>]*)>(.*?)</button>", cls.html, re.S)

    def test_there_are_buttons(self):
        self.assertGreater(len(self.buttons), 60)

    def test_every_button_with_an_id_is_referenced_by_a_script(self):
        dead = []
        for attrs, label in self.buttons:
            m = re.search(r'\bid="([^"]+)"', attrs)
            if m and m.group(1) not in self.js:
                dead.append((m.group(1), re.sub(r"<[^>]+>", "", label).strip()))
        self.assertEqual(dead, [], "buttons whose id no script references")

    def test_every_data_attribute_button_has_a_handler(self):
        attrs_seen = {}
        for attrs, label in self.buttons:
            if re.search(r'\bid="', attrs):
                continue
            for name, value in re.findall(r'\b(data-[a-z-]+)="([^"]*)"', attrs):
                attrs_seen.setdefault(name, set()).add(value)
        self.assertTrue(attrs_seen)
        for name, values in attrs_seen.items():
            camel = re.sub(r"-([a-z])", lambda m: m.group(1).upper(), name[5:])
            handled = name in self.js or ("dataset." + camel) in self.js or ("dataset[\"" + camel) in self.js or ("[" + name) in self.js
            self.assertTrue(handled, f"{name} buttons ({sorted(values)[:4]}) have no handler")

    def test_command_buttons_are_all_known_to_the_server(self):
        cmds = set(re.findall(r'data-cmd="([A-Z_]+)"', self.html))
        app = (PUBLIC.parent / "src" / "app.py").read_text(encoding="utf-8")
        for c in cmds:
            self.assertIn(c, app, f"{c} button has no server-side command")

    def test_buttons_are_real_buttons_not_submit(self):
        for attrs, label in self.buttons:
            self.assertIn("type=", attrs, "button without explicit type (would submit a form): " + attrs[:60])

    # Buttons that intentionally share a handler because they live in different, never-simultaneous contexts.
    SHARED_HANDLER_ALLOWED = {frozenset({"logoutBtn", "sideLogoutBtn"})}

    def test_no_two_buttons_are_bound_to_the_same_click_handler(self):
        ids = {m for attrs, _ in self.buttons for m in re.findall(r'\bid="([^"]+)"', attrs)}
        by_fn = {}
        for js in PUBLIC.glob("*.js"):
            if js.name in SKIP_JS:
                continue
            text = js.read_text(encoding="utf-8")
            for bid, fn in re.findall(r'\$\("([A-Za-z0-9_]+)"\)\??\.addEventListener\("click",\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\)', text):
                if bid in ids:
                    by_fn.setdefault((js.name, fn), set()).add(bid)
        dupes = {k: sorted(v) for k, v in by_fn.items() if len(v) > 1 and frozenset(v) not in self.SHARED_HANDLER_ALLOWED}
        self.assertEqual(dupes, {}, "duplicate controls: different buttons run the same handler")

    def test_icon_only_camera_buttons_have_accessible_names(self):
        for bid in ("camShotBtn", "camRecordBtn", "camFullscreenBtn"):
            m = re.search(r'<button[^>]*id="%s"[^>]*>' % bid, self.html)
            self.assertIsNotNone(m, bid)
            self.assertIn("aria-label=", m.group(0), bid)

    def test_return_to_base_exists_once_on_the_dashboard(self):
        fleet = (PUBLIC / "fleet-panel.js").read_text(encoding="utf-8")
        self.assertNotIn('btn("↩ RETURN TO BASE"', fleet)
        self.assertEqual(self.html.count('id="returnToBaseBtn"'), 1)
        app = (PUBLIC / "app.js").read_text(encoding="utf-8")
        i = app.index("function requestReturnToBase")
        self.assertIn("confirm(", app[i:i + 600], "fleet return-to-base must ask for confirmation")


if __name__ == "__main__":
    unittest.main()

