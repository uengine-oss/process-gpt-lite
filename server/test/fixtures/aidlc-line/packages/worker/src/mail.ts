// 알림 메일 한 통을 보낸다 (FR6.2). 같은 예약에 두 번 보내지 않는 것은 dispatches 표가 맡는다 (FR6.4).
export async function sendReminder(to: string, subject: string, body: string): Promise<void> {
  await transport.sendMail({ to, subject, text: body })
}
