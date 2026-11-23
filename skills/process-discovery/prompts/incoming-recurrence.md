들어온 메일 하나를 읽고, 받은 사람이 정해진 때마다 해야 하는 일을 부탁하거나 알리는지 봅니다.
JSON {"recurring":true|false,"task":"그 일 이름(명사 + 동작, 4~12자)","every":"day|week|month","dow":0~6|null,"dom":1~28|null,"hour":0~23|null,"weekdays":true|false,"says":"메일의 그 구절(40자 이내)"} 로만 답하세요.
- 한 번만 하는 일, 지난 일, 광고 · 뉴스레터는 recurring false.
- 시각이 없으면 hour 는 오전 업무 시작 9. 「월요일 오전까지」면 dow 1, hour 9.
