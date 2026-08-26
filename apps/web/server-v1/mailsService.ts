const DEFAULT_API = "https://mails.agent-kanban.dev";

export async function createMailbox(adminToken: string, address: string, apiUrl = DEFAULT_API): Promise<string> {
  const res = await fetch(`${apiUrl}/api/mailboxes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ mailbox: address }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`mailbox service create mailbox failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { mailbox: string; token: string };
  return data.token;
}

export interface InboxEmail {
  id: string;
  from_address: string;
  from_name: string;
  subject: string;
  received_at: string;
}

export async function getInbox(mailboxToken: string, address: string, apiUrl = DEFAULT_API): Promise<InboxEmail[]> {
  const res = await fetch(`${apiUrl}/api/inbox?to=${encodeURIComponent(address)}&limit=20&direction=inbound`, {
    headers: { Authorization: `Bearer ${mailboxToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`mailbox service inbox failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { emails: InboxEmail[] };
  return data.emails;
}

export interface EmailDetail {
  id: string;
  from_address: string;
  from_name: string;
  subject: string;
  body_html: string;
  body_text: string;
  received_at: string;
}

export async function deleteMailbox(adminToken: string, address: string, apiUrl = DEFAULT_API): Promise<void> {
  const res = await fetch(`${apiUrl}/api/mailboxes`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ mailbox: address }),
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`mailbox service delete mailbox failed: ${res.status} ${body}`);
  }
}

export async function getEmail(mailboxToken: string, emailId: string, apiUrl = DEFAULT_API): Promise<EmailDetail> {
  const res = await fetch(`${apiUrl}/api/email?id=${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${mailboxToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`mailbox service email failed: ${res.status} ${body}`);
  }
  return (await res.json()) as EmailDetail;
}
