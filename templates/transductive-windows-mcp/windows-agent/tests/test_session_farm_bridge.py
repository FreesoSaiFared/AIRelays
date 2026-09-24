from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from transductive_agent.session_farm_bridge import SessionFarmBridge


class SessionFarmBridgeTests(unittest.TestCase):
    def test_system_default_config_uses_programdata_not_systemprofile(self) -> None:
        with tempfile.TemporaryDirectory() as td, patch.dict(
            os.environ,
            {"ProgramData": td, "USERNAME": "SYSTEM", "LOCALAPPDATA": r"C:\Windows\System32\config\systemprofile\AppData\Local"},
            clear=False,
        ):
            bridge = SessionFarmBridge({})
            expected = Path(td) / "Transductive" / "WindowsMCP" / "AIRelays" / "session-farm" / "session-farm.config.json"
            self.assertEqual(bridge._config_path({}), expected.resolve())

    def test_origin_rejects_non_loopback_control_listener(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = Path(td) / "config.json"
            config.write_text(json.dumps({"listen": {"host": "0.0.0.0", "port": 39817}}), encoding="utf-8")
            bridge = SessionFarmBridge({})
            with self.assertRaisesRegex(RuntimeError, "non-loopback"):
                bridge._origin(config)

    def test_repo_root_requires_canonical_session_farm_marker(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            bridge = SessionFarmBridge({})
            with self.assertRaisesRegex(RuntimeError, "invalid AIRelays repoRoot"):
                bridge._repo_root({"repoRoot": td})

    def test_bind_rejects_non_chatgpt_url_before_network_call(self) -> None:
        bridge = SessionFarmBridge({})
        with patch.object(bridge, "_config_path", return_value=Path("config.json")), patch.object(
            bridge, "_repo_root", return_value=None
        ), patch.object(bridge, "_http") as http:
            with self.assertRaisesRegex(RuntimeError, "only accepts https://chatgpt.com/"):
                bridge.call("farm_bind", {"slot": "w1", "url": "https://example.com/"})
            http.assert_not_called()

    def test_worker_ids_are_closed_set(self) -> None:
        self.assertEqual(SessionFarmBridge._worker({"worker": "w6"}), "w6")
        with self.assertRaisesRegex(RuntimeError, "w1..w6"):
            SessionFarmBridge._worker({"worker": "w7"})

    def test_seed_passes_prompt_over_stdin_not_command_line(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            script = root / "tools" / "session-farm" / "seed-session.mjs"
            script.parent.mkdir(parents=True)
            script.write_text("// fixture", encoding="utf-8")
            config = root / "config.json"
            config.write_text("{}", encoding="utf-8")
            bridge = SessionFarmBridge({})
            completed = subprocess.CompletedProcess(
                args=["node"], returncode=0,
                stdout='{"ok":true,"slot":"w1","verified":true}\n', stderr="",
            )
            with patch.object(bridge, "_repo_root", return_value=root), patch.object(
                bridge, "_node", return_value="node.exe"
            ), patch.object(bridge, "_remember"), patch(
                "transductive_agent.session_farm_bridge.subprocess.run", return_value=completed
            ) as run:
                receipt = bridge._seed({"slot": "w1", "prompt": "mission secret"}, config)
            self.assertTrue(receipt["ok"])
            argv = run.call_args.args[0]
            self.assertNotIn("mission secret", argv)
            self.assertEqual(run.call_args.kwargs["input"], "mission secret")
            self.assertIn("--slot", argv)
            self.assertIn("w1", argv)

    def test_seed_rejects_unknown_slot_before_process_launch(self) -> None:
        bridge = SessionFarmBridge({})
        with patch.object(bridge, "_repo_root", return_value=Path(".")), patch(
            "transductive_agent.session_farm_bridge.subprocess.run"
        ) as run:
            with self.assertRaisesRegex(RuntimeError, "w1..w6 or orch"):
                bridge._seed({"slot": "w7", "prompt": "mission"}, Path("config.json"))
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
