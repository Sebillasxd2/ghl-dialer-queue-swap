export type LineType = "mobile" | "landline" | "voip" | "toll_free" | "unknown";

/** A rep and the GHL objects their queue is built from. */
export interface Rep {
  id: string;
  name: string;
  /** GHL user id. Contacts must be assigned to it or a restricted user sees nothing. */
  ghlUserId: string;
  /** Adding this tag is what fires the rep's dialer workflow. */
  queueTag: string;
  /** The workflow whose "tag added" trigger puts a contact into the rep's call queue. */
  workflowId: string;
}

/** A row from the local `leads` table: the candidates for today's queue. */
export interface Lead {
  id: string;
  company: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone: string;
  lineType?: LineType;
  city?: string;
  state?: string;
}

/** A row from the local `calls` table: the dial history used for cool-off. */
export interface Call {
  phone: string;
  calledAt: string;
  repId: string;
  outcome: string;
}

/** The subset of a GHL contact this tool reads. */
export interface Contact {
  id: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  email?: string;
  tags: string[];
  assignedTo?: string | null;
}

export interface UpsertInput {
  phone: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  companyName?: string;
  assignedTo: string;
  source?: string;
}
