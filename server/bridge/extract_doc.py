"""Read a regulation or procedure document's text with process-gpt's own document reader (bpmn-extractor, PDF2BPMN).

stdin : {"chunks": ["text", ...], "existing": {"processes": [...], "roles": [...], "tasks": [{name, role, process, order}]}}
stdout: one JSON line {"processes", "tasks", "roles", "gateways", "events", "decisions", "rules",
        "task_role_mappings", "task_process_mappings", "sequence_flows"} — every chunk's entities, the later chunks
        reading with what the earlier ones found (the same accumulated context PDF2BPMN's workflow gives them)
stderr: "chunk i/n" progress lines
Uses, unchanged: services/bpmn-extractor src/pdf2bpmn/extractors/entity_extractor.EntityExtractor.extract_from_text
  (no Neo4j: only its LLM prompt and parser). Its Config reads OPENAI_API_KEY · LLM_BASE_URL · LLM_MODEL from the
  environment first — the server passes Lite's own model endpoint.
Env: PGPT_ROOT
"""
import json
import os
import sys
import types

root = os.environ.get("PGPT_ROOT", "")
src = os.path.join(root, "services", "bpmn-extractor", "src")
sys.path.insert(0, src)

# the extractors package's __init__ also loads its PDF reader (pdfplumber), which this needs not: Lite turns the
# file into text itself (lib/folders/indexer.js) — the package is entered without it
import pdf2bpmn  # noqa: E402,F401
_pkg = types.ModuleType("pdf2bpmn.extractors")
_pkg.__path__ = [os.path.join(src, "pdf2bpmn", "extractors")]
sys.modules["pdf2bpmn.extractors"] = _pkg
from pdf2bpmn.extractors.entity_extractor import EntityExtractor  # noqa: E402

KEYS = ["processes", "tasks", "roles", "gateways", "events", "decisions", "rules",
        "task_role_mappings", "task_process_mappings", "sequence_flows"]


def main():
    req = json.loads(sys.stdin.read() or "{}")
    chunks = [c for c in req.get("chunks") or [] if str(c).strip()]
    ex = req.get("existing") or {}
    procs = list(ex.get("processes") or [])
    roles = list(ex.get("roles") or [])
    tasks = list(ex.get("tasks") or [])
    out = {k: [] for k in KEYS}
    reader = EntityExtractor()
    for i, text in enumerate(chunks):
        print(f"chunk {i + 1}/{len(chunks)}", file=sys.stderr, flush=True)
        got = reader.extract_from_text(text, existing_processes=procs, existing_roles=roles, existing_tasks=tasks)
        part = got.model_dump() if hasattr(got, "model_dump") else got.dict()
        for k in KEYS:
            for x in part.get(k) or []:
                out[k].append({**x, "chunk": i})
        # what the later chunks read with: the names found so far
        procs += [p.get("name") for p in part.get("processes") or [] if p.get("name") and p.get("name") not in procs]
        roles += [r.get("name") for r in part.get("roles") or [] if r.get("name") and r.get("name") not in roles]
        owner = {m.get("task_name"): m.get("role_name") for m in part.get("task_role_mappings") or [] if isinstance(m, dict)}
        within = {m.get("task_name"): m.get("process_name") for m in part.get("task_process_mappings") or [] if isinstance(m, dict)}
        for t in part.get("tasks") or []:
            n = t.get("name")
            if n and not any(x.get("name") == n for x in tasks):
                tasks.append({"name": n, "role": owner.get(n) or "", "process": within.get(n) or t.get("parent_process") or "", "order": t.get("order")})
    print(json.dumps(out, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
