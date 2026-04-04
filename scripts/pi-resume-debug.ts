import { createAgentSession, SessionManager, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";

async function inspect(label: string, sm: any) {
  const loader = new DefaultResourceLoader(process.cwd());
  const { session } = await createAgentSession({
    sessionManager: sm,
    resourceLoader: loader,
  });
  const header = session.sessionManager.getHeader?.();
  const entries = session.sessionManager.getEntries();
  const branch = session.sessionManager.getBranch();
  console.log(JSON.stringify({
    label,
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
    header,
    entriesLength: entries.length,
    branchLength: branch.length,
    leafId: session.sessionManager.getLeafId?.(),
    firstEntry: entries[0],
    lastEntry: entries[entries.length - 1],
  }, null, 2));
  await session.shutdown?.();
}

const cwd = process.cwd();
await inspect('create', SessionManager.create(cwd, '/tmp/pi-resume-debug-sessions'));
await inspect('continueRecent', SessionManager.continueRecent(cwd, '/tmp/pi-resume-debug-sessions'));
const sessions = await SessionManager.list(cwd, '/tmp/pi-resume-debug-sessions');
if (sessions[0]) {
  await inspect('open-existing', SessionManager.open(sessions[0].path));
}
