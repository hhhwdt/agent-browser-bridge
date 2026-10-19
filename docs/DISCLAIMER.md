# Disclaimer and rules of use

English · [简体中文](DISCLAIMER.zh-CN.md)

Read this before you install or call Agent Browser Bridge. It is a condition of using it.

---

## 1. What it actually does

Once installed, **any program on this machine that can reach `127.0.0.1:18777` and read the token
file** can make your browser:

- read the text, links and frame structure of pages you are signed in to, and take screenshots
- click, type, press keys and navigate
- run arbitrary JavaScript inside a page
- read cookies (including `httpOnly` ones) and localStorage / sessionStorage
- download files into your download folder, and put local files into a page's upload control
- close tabs

Every action is sent **with your own logged-in session**. From the site's side, you are the one
doing it.

It does not switch tabs, steal focus or move the mouse. Which also means: **it keeps working while
you are not watching.** There are visible hints — a floating badge on the page, a mark on the
toolbar icon, a prefix on the tab title — but they notify, they do not prevent.

## 2. What you have to judge for yourself

The tool executes; it does not decide whether something should be executed. Nothing here can make
these judgements for you:

1. **Where the instruction came from.** You cannot tell from the tool whether the agent passed your
   request through faithfully or improvised. Check which button it is about to press and which form
   it is about to submit.
2. **Irreversible actions.** Submitting, publishing, sending, deleting, paying, approving. Once it
   goes out, it is gone. The risk classification here (destructive-looking buttons need an explicit
   `--force`) guards against accidental clicks. It is not a security boundary.
3. **The site's rules.** Many sites forbid automation in their terms of service, and internal
   systems carry their own compliance requirements. Whether you may do this, and what follows if you
   do, is your call.
4. **The scope of a grant.** Site access is granted per site, but two things are wider than they
   look: granting "all sites" hands over read access to the whole browser, and the `cookies`
   permission, once granted, applies to **every** open tab rather than only to the sites you
   authorised.
5. **Who else is on the machine.** The bridge requires a shared token that the extension reads
   from `chrome.storage.local`. A second extension cannot read the token file, so it cannot drive
   the bridge. However, a local process running as the same user can read the token from disk.
   Do not run it on a shared or already-compromised machine.

## 3. What it is not

- Not a way to get past logins, CAPTCHAs, DRM or anti-bot systems. It reuses a session you already
  have; it does not break anything open. DRM-protected content is out of scope.
- Not something that hides its presence. It leaves visible marks.
- Not for driving **someone else's** browser or **someone else's** account. Operating another
  person's browser or reading their data without authorisation is abuse, and is outside the scope of
  this project. You would be on your own.

## 4. Liability

The software is provided "as is" under the MIT licence, without warranty of any kind. The authors
and contributors are not liable for lost or corrupted data, restricted or banned accounts, anything
it sends on your behalf, or any consequence of violating a third party's terms of service or the
law.

Nothing here limits rights you have under the law of your jurisdiction, and nothing here excuses
intent or gross negligence.

## 5. Reducing the risk

- Grant site access one site at a time, and revoke when you are done (the popup has a revoke-all
  button).
- Leave the `cookies` permission off unless you actually need it.
- Run the bridge only while you need it; stop it afterwards.
- The port is bound to loopback. Do not change that to listen on the network.
- Before pointing an agent at shared documents, production systems, or anything with real people on
  the other end, ask the people involved.

## 6. Vulnerabilities

Report security issues the way [SECURITY.md](SECURITY.md) describes, not in a public issue.
