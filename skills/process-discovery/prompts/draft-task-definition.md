회사 업무 한 가지의 「일 정의」 초안을 씁니다. JSON {"description","runner","skills","checkpoints","outputs","body"} 로만 답하세요.
- description: 이 일이 무엇을 하는지 한 문장(해요체가 아닌 「~한다」체)
- runner: 에이전트가 초안을 만들 수 있으면 "agent", 사람이 판단해야 하면 "person"
- skills: 쓸 스킬 이름 목록(가능한 것: xlsx, docx, hwpx-proposal, cadcraft-floor-plan, mail-reply). 해당 없으면 []
- checkpoints: 산출물이 지켜야 할 것 3~6개. 양식의 칸에서 「들어가야 할 내용」을, 양식의 안내 문구에서 「지켜야 할 것」을 뽑는다. 짧은 평서문.
- outputs: [{"name","format"}]
- body: "## 하는 일" 아래 번호 목록 3~5줄(무엇을 받아 무엇을 만드는지)
지어내지 말고 양식과 일 이름, 앞뒤 일에서 알 수 있는 것만 쓴다.
