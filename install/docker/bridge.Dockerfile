# The bridge on its own (production k8s): process-gpt's save path for generated process definitions —
# 정식 등록 of a mined flow, chat process generation, process improvement. The Docker bundle runs the
# same server/bridge/serve.py from the deepagents image with process-gpt mounted; here the two files
# save_generated.py uses come in as build contexts, at the commits backends/process-gpt pins:
#   skill      = uengine-oss/bpmn-process-generation-skill   (scripts/save_to_supabase.py: save_contract)
#   extractor  = uengine-oss/process-gpt-bpmn-extractor      (src/pdf2bpmn/processgpt/bpmn_xml_generator.py)
# Build (context: server/bridge):
#   docker build -f install/docker/bridge.Dockerfile --build-context skill=<dir> --build-context extractor=<dir> server/bridge
FROM python:3.12-slim

ENV TZ=Asia/Seoul PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PGPT_ROOT=/pgpt BRIDGE_PORT=8790
# save_to_supabase's only third-party import (the version deepagents runs it with)
RUN pip install --no-cache-dir "supabase==2.31.0"

COPY --from=skill scripts/save_to_supabase.py /pgpt/skills/bpmn-process-generation-skill/scripts/save_to_supabase.py
COPY --from=extractor src/pdf2bpmn/processgpt/bpmn_xml_generator.py /pgpt/services/bpmn-extractor/src/pdf2bpmn/processgpt/bpmn_xml_generator.py
COPY serve.py save_generated.py /lite/bridge/

RUN useradd -r -u 10001 bridge
USER bridge
EXPOSE 8790
CMD ["python", "/lite/bridge/serve.py"]
