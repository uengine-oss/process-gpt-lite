# Process GPT Lite on kind (다음 단계 — 아직 미구현)

Compose 번들을 그대로 kind로 옮기지 못하는 이유와, 옮길 때의 설계입니다.

## 막히는 지점

1. **샌드박스**: deepagents(`core/sandbox/docker_sandbox.py`)는 Docker SDK로 호스트 데몬에 샌드박스
   컨테이너를 띄우고, 작업 폴더를 같은 절대 경로로 bind 합니다. kind 노드는 containerd라 Docker 소켓이 없습니다.
   Kubernetes 백엔드(Pod/Job 샌드박스)는 deepagents에 아직 없습니다.
2. **기존 매니페스트**: `uengine-oss/process-gpt-k8s`는 core 서비스(frontend, completion, memento, polling,
   gateway 등)만 있고 Supabase는 매니지드를 가정합니다. pgpt-pro·office-host·office-mcp·deepagents 매니페스트는 없습니다.

## 설계안 (권장 순서)

1. 이미지: compose가 만드는 6개 이미지(`server`, `web`, `deepagents`, `office-mcp`, `office-host`, `completion`)를
   `kind load docker-image` 또는 로컬 레지스트리로 넣는다.
2. Supabase: 같은 최소 구성(db·auth·rest·storage·kong)을 StatefulSet/Deployment로, 또는 supabase-kubernetes Helm 차트.
   `install/db/migrate.sh`와 `seed.sql`은 그대로 Job으로 돈다(마운트만 ConfigMap으로).
3. deepagents 샌드박스: Pod 안에 `docker:dind` 사이드카(privileged)를 두고 `DOCKER_HOST=tcp://localhost:2375`,
   작업 폴더 PVC를 deepagents와 dind 양쪽에 **같은 경로**(`DEEPAGENTS_HOME`)로 마운트한다.
   compose의 entrypoint(`docker/deepagents-entrypoint.sh`)가 그대로 맞는다. 장기적으로는 deepagents에
   Kubernetes 샌드박스 백엔드를 추가하는 것이 맞다.
4. server Pod는 같은 PVC(workspace·skills)를 `/pgpt/services/deepagents/...`로 마운트한다(ReadWriteMany 또는 같은 노드).
5. web(nginx)을 Ingress 뒤에 두고 `PUBLIC_URL`을 Ingress 주소로. localhost가 아니면 loopback 포워드가 필요 없다.

예상 작업량: 매니페스트(또는 Helm 차트) 1~2일, dind 샌드박스 검증 반나절.
