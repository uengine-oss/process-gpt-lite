"""Save a deepagents process-generation result with process-gpt's own code.

stdin : the `process_result.data` contract from deepagents (bpmn-process-generation-skill)
stdout: JSON summary
Uses, unchanged:
  - skills/.../bpmn-process-generation-skill/scripts/save_to_supabase.save_contract
      (proc_def + proc_map + form_def + agents + tenant skills)
  - bpmn-extractor .../processgpt/bpmn_xml_generator.ProcessGPTBPMNXmlGenerator.create_bpmn_xml
      (Python port of the frontend BPMNXmlGenerator.vue#createBpmnXml) for proc_def.bpmn,
      which is what the process-gpt frontend stores when a user presses save.
Env: PGPT_ROOT, TENANT_ID, SUPABASE_URL, SERVICE_ROLE_KEY
"""
import importlib.util
import json
import os
import re
import sys
import uuid

root = os.environ.get("PGPT_ROOT") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "backends", "process-gpt")
# deepagents' copy of the skill no longer writes to the database (the frontend saves with the
# user's credentials); the repository's own copy of the same skill still carries save_contract.
skill = next(p for p in (f"{root}/skills/bpmn-process-generation-skill/scripts",
                         f"{root}/services/deepagents/skills/process-gpt-system/bpmn-process-generation-skill/scripts")
             if "def save_contract" in open(f"{p}/save_to_supabase.py", encoding="utf-8").read())
sys.path.insert(0, skill)
import save_to_supabase  # noqa: E402
from save_to_supabase import save_contract, get_client  # noqa: E402

# complete_process_generation hands back an already flattened definition; save_contract expects
# the elements[] form, so pass flattened definitions through unchanged.
_flatten = save_to_supabase.flatten
save_to_supabase.flatten = lambda pd: pd if (pd or {}).get("activities") and not (pd or {}).get("elements") else _flatten(pd)

spec = importlib.util.spec_from_file_location(
    "bpmn_xml_generator", f"{root}/services/bpmn-extractor/src/pdf2bpmn/processgpt/bpmn_xml_generator.py")
gen = importlib.util.module_from_spec(spec)
sys.modules["bpmn_xml_generator"] = gen  # dataclasses look the module up while it executes
spec.loader.exec_module(gen)

contract = json.load(sys.stdin)

# The streamed contract can predate the forms; when the generation folder is known, assemble
# the final contract again with deepagents' own complete_process_generation helper.
work = os.environ.get("WORK_DIR")
if work and not os.path.isdir(work):
    print(f"generation folder not found, saving the streamed contract as is: {work}", file=sys.stderr)
if work and os.path.isdir(work):
    sys.path.insert(0, f"{root}/services/deepagents")
    from pathlib import Path
    from core.skills import tools as gen_tools  # noqa: E402
    rebuilt = gen_tools._complete_one_process(Path(work), persist=False)
    if rebuilt:
        contract = rebuilt
# one form per activity: the skill's .form wins over a stray .html copy (both are listed, .form first)
seen = set()
contract["forms"] = [f for f in (contract.get("forms") or []) if not (f.get("activity_id") in seen or seen.add(f.get("activity_id")))]
# CONTRACT_ONLY=1 (ASSEMBLE_ONLY: the bridge's /assemble): only the contract as it would be saved — the
# chat's draft card shows it (nothing is written)
if os.environ.get("CONTRACT_ONLY") == "1" or os.environ.get("ASSEMBLE_ONLY"):
    print(json.dumps(contract if isinstance(contract.get("processDefinition"), dict) else {}, ensure_ascii=False))
    sys.exit(0)
tenant = os.environ.get("TENANT_ID", "localhost")
sb = get_client()


def _is_uuid(s):
    try:
        uuid.UUID(str(s))
        return True
    except ValueError:
        return False


def ensure_agents(contract):
    """The generation's agents (agents/<slug>.json) become agent users, the way the process-gpt UI saves
    a generated process (ProcessGPTBackend.saveGeneratedProcessArtifacts → putAgent): an agent with the
    same name is reused, otherwise a new one is made. save_contract only maps skills onto agent users
    that already exist, so without this nothing of the agents was saved. The definition names agents by
    slug (roles' endpoint/default, activities' agent): those point at the user ids afterwards."""
    agents = contract.get("agents") or []
    if not agents:
        return []
    norm = lambda v: re.sub(r"\s+", "", str(v or "")).lower()
    existing = sb.table("users").select("id,username").eq("tenant_id", tenant).eq("is_agent", True).execute().data or []
    ids, made = {}, []
    for a in agents:
        slug = str(a.get("id") or "").strip()
        name = str(a.get("name") or a.get("username") or "").strip()
        # an agent named only by an existing user id (e.g. a mined process's catalog agents) is already saved
        dup = next((u for u in existing if slug and str(u.get("id")) == slug), None) or \
            next((u for u in existing if name and norm(u.get("username")) == norm(name)), None)
        if not dup and not name:
            continue
        if dup:
            uid = str(dup["id"])
        else:
            uid = slug if _is_uuid(slug) else str(uuid.uuid4())
            skills = a.get("skills") or []
            row = {"id": uid, "username": name, "email": f"{slug or 'agent'}-{uid[:6]}@{tenant}", "tenant_id": tenant,
                   "is_agent": True, "is_admin": False, "agent_type": "agent", "alias": slug or None,
                   "role": a.get("role"), "goal": a.get("goal"), "persona": a.get("persona"), "description": a.get("description"),
                   "tools": a.get("tools") if isinstance(a.get("tools"), str) else None,
                   "skills": ",".join(skills) if isinstance(skills, list) and skills else None}
            sb.table("users").insert({k: v for k, v in row.items() if v is not None}).execute()
            existing.append({"id": uid, "username": name})
            made.append(uid)
        if slug and slug != uid:
            ids[slug] = uid
        a["id"] = uid

    def sub(v):
        if isinstance(v, str):
            return ids.get(v, v)
        if isinstance(v, list):
            return [sub(x) for x in v]
        return v

    def walk(o):
        if isinstance(o, dict):
            for k, v in list(o.items()):
                if k in ("agent", "endpoint", "default"):
                    o[k] = sub(v)
                else:
                    walk(v)
        elif isinstance(o, list):
            for x in o:
                walk(x)

    walk(contract.get("processDefinition"))
    return made


agents_created = ensure_agents(contract)
result = save_contract(contract, tenant_id=tenant, sb=sb)
result["agents_created"] = agents_created

xml = None
try:
    xml = gen.ProcessGPTBPMNXmlGenerator().create_bpmn_xml(contract.get("processDefinition") or {})
    sb.table("proc_def").update({"bpmn": xml}).eq("id", result["proc_def_id"]).eq("tenant_id", tenant).execute()
except Exception as e:  # the definition is saved either way; the UI falls back to the step list
    print(f"bpmn generation failed: {e}", file=sys.stderr)

result.pop("definition", None)
result["bpmn_bytes"] = len(xml or "")
print(json.dumps(result, ensure_ascii=False))
