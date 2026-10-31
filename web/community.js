(function () {
  'use strict';

  const links = window.LIDEX_COMMUNITY_LINKS;
  const sections = [
    ['home', 'Community'],
    ['programs', 'Apply'],
    ['announcements', 'Announcements'],
    ['discussions', 'Discussions'],
    ['governance', 'Governance'],
    ['ambassadors', 'Ambassadors'],
    ['developers', 'Developers'],
    ['validators', 'Validators'],
    ['partnerships', 'Partners'],
    ['events', 'Events'],
    ['grants', 'Grants'],
    ['contributors', 'Contributors'],
    ['help', 'Help center'],
  ];

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));

  function socialLink(key, label, className = 'btn ghost') {
    const url = links[key];
    if (!url) throw new Error(`Missing Lidex community link: ${key}`);
    return `<a class="${className}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  function socialIconLink(key, label, path) {
    const url = links[key];
    if (!url) throw new Error(`Missing Lidex community link: ${key}`);
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" aria-label="Lidex on ${label}">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${path}"/></svg>
    </a>`;
  }

  function formLink(key, label, className = 'btn') {
    const value = links.forms[key];
    let href = '#community-form-pending';
    let target = '';
    if (value) {
      const url = new URL(value);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(`Community form link "${key}" must use HTTP or HTTPS.`);
      }
      href = url.href;
      target = ' target="_blank" rel="noopener noreferrer"';
    }
    return `<a class="${className}" href="${escapeHtml(href)}" data-community-form="${escapeHtml(key)}"${target}>${label}</a>`;
  }

  function card(icon, title, description, href, action) {
    return `<article class="card community-card">
      <div class="community-icon" aria-hidden="true">${icon}</div>
      <h3>${title}</h3><p>${description}</p>
      ${action ? `<a class="community-card-link" href="${href}">${action} →</a>` : ''}
    </article>`;
  }

  function formCard(icon, title, description, key, action) {
    return `<article class="card community-card">
      <div class="community-icon" aria-hidden="true">${icon}</div>
      <h3>${title}</h3><p>${description}</p>${formLink(key, action, 'btn ghost')}
    </article>`;
  }

  function emptyState(title, description, action = '') {
    return `<div class="community-empty"><h3>${title}</h3><p>${description}</p>${action}</div>`;
  }

  function sectionHeading(title, description = '') {
    return `<div class="community-section-heading"><div><h2>${title}</h2>${description ? `<p>${description}</p>` : ''}</div></div>`;
  }

  function homePage() {
    const stats = [
      ['—', 'Community members'],
      ['—', 'Active contributors'],
      ['—', 'Ambassadors'],
      ['—', 'Published proposals'],
      ['—', 'Events hosted'],
    ];
    return `<section class="community-hero">
      <div class="eyebrow">The Lidex community</div>
      <h1>Together, we build Lidex.</h1>
      <p>Meet builders, share ideas, learn about the network, and find ways to contribute. Join the public channels to take part in conversations.</p>
      <div class="community-actions">
        ${socialLink('telegram', 'Join the Telegram', 'btn')}
        ${socialLink('x', 'Follow Lidex on X', 'btn ghost')}
      </div>
    </section>
    <section class="community-section">
      ${sectionHeading('Community at a glance', 'Public participation data is not connected to this static website. No live member, activity, or program totals are currently published here.')}
      <div class="community-stat-grid">${stats.map(([value, label]) => `<div class="card community-stat"><span class="stat-label">${label}</span><strong>${value}</strong><span>Not published</span></div>`).join('')}</div>
    </section>
    <section class="community-section">
      ${sectionHeading('Find your place', 'Browse community information and choose how you want to get involved.')}
      <div class="community-grid">${card('✦', 'Announcements', 'Official Lidex updates and notices. No announcements are published on this page yet.', '#/community/announcements', 'View announcements')}
        ${card('◎', 'Discussions', 'Join open conversations through Lidex’s public community channels.', '#/community/discussions', 'Explore discussions')}
        ${card('◇', 'Governance', 'Learn how proposals can be discussed. This page does not conduct votes.', '#/community/governance', 'Read about governance')}
        ${card('↗', 'Ambassadors', 'Discover the ambassador program and its expectations.', '#/community/ambassadors', 'Explore the program')}
        ${card('▦', 'Events', 'Check for published events or suggest one for the community.', '#/community/events', 'View events')}
        ${card('＋', 'Grants', 'Review the grants information. No funding commitments are made here.', '#/community/grants', 'Explore grants')}
      </div>
    </section>
    <section class="community-section community-bottom-cta">
      ${sectionHeading('Ready to get involved?', 'Explore community programs and choose how you would like to participate.')}
      <div class="community-actions"><a class="btn" href="#/community/programs">View programs and applications</a>${socialLink('telegram', 'Join the community', 'btn ghost')}</div>
    </section>`;
  }

  function programsPage() {
    const actions = [
      ['◇', 'Ambassador Programme', 'Help introduce people to Lidex and support the community.', 'ambassador', 'Apply as Ambassador'],
      ['⌘', 'Developer Programme', 'Build applications, infrastructure, integrations, and tools for Lidex.', 'developer', 'Apply as Developer'],
      ['◉', 'Validator Interest', 'Express interest in supporting network security and reliability.', 'validator', 'Express Validator Interest'],
      ['＋', 'Ecosystem Grants', 'Propose a project that can contribute to the Lidex ecosystem.', 'grant', 'Apply for a Grant'],
      ['↔', 'Partnerships', 'Explore collaboration with Lidex as an organisation or project.', 'partnership', 'Become a Partner'],
      ['✦', 'Community Contributors', 'Contribute through education, research, documentation, design, or support.', 'contributor', 'Become a Contributor'],
      ['▦', 'Lidex Events', 'Register your interest in Lidex meetings, workshops, and events.', 'eventRegistration', 'Register for an Event'],
      ['?', 'Contact and Support', 'Contact the Lidex team with a question or support request.', 'support', 'Contact Support'],
    ];
    return `<div class="eyebrow">Get involved</div><h1 class="community-page-title">Programs &amp; Applications</h1>
      <p class="community-page-lede">Choose a Lidex program below. Each action is ready for its corresponding Typeform URL; links can be added in the community link configuration when available.</p>
      <div class="community-grid">${actions.map(([icon, title, description, key, label]) => formCard(icon, title, description, key, label)).join('')}</div>
      <section class="community-section community-policy">
        ${sectionHeading('Reward and support policy', 'Approved participants may qualify for programme-specific support. Applying or participating does not guarantee a reward, grant, or selection.')}
        <p>Depending on the programme, approved participants may receive LDX rewards for verified contributions, milestone-based rewards, recognition, certificates, community badges, ecosystem grants, or development support. Eligibility, verification, available budget, and approval apply. Specific amounts, distribution schedules, and conditions will be shared through official Lidex channels and programme agreements.</p>
        <p>Never provide wallet passwords, private keys, or recovery phrases. Forms are hosted externally when their official Typeform links are configured; this website does not collect applications.</p>
        <details class="community-consent"><summary>Privacy and consent text for the Typeforms</summary>
          <p>By submitting the external form, you agree that Lidex may use the information provided to review your application, communicate with you, and administer the relevant community programme.</p>
          <p>Your information will be handled according to the applicable Lidex privacy policy. You may contact Lidex on Telegram at <a href="https://t.me/lidexblockchain" target="_blank" rel="noopener noreferrer">@lidexblockchain</a> with questions about your submitted information.</p>
          <p>This statement and a required consent checkbox should be added to each relevant Typeform when its URL is configured.</p>
        </details>
      </section>
      <p class="community-status-note">Questions? Contact Lidex on Telegram: <a href="https://t.me/lidexblockchain" target="_blank" rel="noopener noreferrer">@lidexblockchain</a>.</p>`;
  }

  function announcementsPage() {
    return `<div class="eyebrow">Community</div><h1 class="community-page-title">Announcements</h1>
      <p class="community-page-lede">Official notices, product updates, ecosystem news, and community highlights from Lidex.</p>
      <div class="community-chip-list" aria-label="Announcement categories">${['Network updates', 'Ecosystem news', 'Community highlights', 'Maintenance notices'].map((label) => `<span class="community-chip">${label}</span>`).join('')}</div>
      <section class="community-section">${emptyState('No official announcements published yet', 'When Lidex publishes an update, it will appear here. Follow the official channels for current notices.', socialLink('x', 'Follow Lidex on X', 'btn ghost'))}</section>`;
  }

  function discussionsPage() {
    return `<div class="eyebrow">Community</div><h1 class="community-page-title">Discussions</h1>
      <p class="community-page-lede">The website does not host a forum, user accounts, or message storage. Join Lidex’s public channels to talk with the community.</p>
      <div class="community-grid two">
        <article class="card community-card"><div class="community-icon" aria-hidden="true">◎</div><h3>Telegram</h3><p>Join public community conversations and ask questions.</p>${socialLink('telegram', 'Open Telegram', 'btn ghost')}</article>
        <article class="card community-card"><div class="community-icon" aria-hidden="true">𝕏</div><h3>Lidex on X</h3><p>Follow public posts and share your thoughts with Lidex.</p>${socialLink('x', 'Visit X', 'btn ghost')}</article>
      </div>
      <section class="community-section">${sectionHeading('Conversation topics')}
        <div class="community-chip-list">${['General community', 'Builders and developers', 'Network updates', 'Ideas and feedback', 'Events and meetups'].map((label) => `<span class="community-chip">${label}</span>`).join('')}</div>
        <p class="community-status-note">These are suggested discussion topics, not live forum categories.</p>
      </section>`;
  }

  function governancePage() {
    const stages = ['Draft an idea', 'Discuss it publicly', 'Revise with feedback', 'Publish an official decision'];
    return `<div class="eyebrow">Community</div><h1 class="community-page-title">Governance &amp; LIPs</h1>
      <p class="community-page-lede">Lidex Improvement Proposals (LIPs) can provide a clear way to document and discuss changes. This static page does not register proposals, count votes, or enact governance decisions.</p>
      <section class="community-section">${sectionHeading('Proposal process', 'A suggested discussion flow; it is not an active on-chain governance process.')}
        <ol class="community-steps">${stages.map((stage) => `<li>${stage}</li>`).join('')}</ol>
      </section>
      <section class="community-section">${emptyState('No active proposals published', 'There is no proposal registry or voting system connected to this page. Any decisions will be announced through official Lidex channels.')}</section>
      <section class="community-section community-bottom-cta">${sectionHeading('Have an idea for a LIP?', 'The proposal link is a placeholder until the official Typeform is provided. Submitting ideas is not available on this website yet.')}
        ${formLink('lip', 'LIP proposal interest', 'btn')}</section>`;
  }

  function ambassadorsPage() {
    return `<div class="eyebrow">Community programs</div><h1 class="community-page-title">Lidex Ambassadors</h1>
      <p class="community-page-lede">Ambassadors help people discover Lidex, support builders, share accurate information, and strengthen local communities.</p>
      <div class="community-grid">
        ${card('◇', 'Community advocate', 'Share verified Lidex information and welcome newcomers.', '', '')}
        ${card('⌘', 'Developer advocate', 'Help builders find resources and exchange technical knowledge.', '', '')}
        ${card('◉', 'Regional organizer', 'Connect local communities and suggest inclusive activities.', '', '')}
      </div>
      <section class="community-section">${sectionHeading('What to expect')}
        <div class="community-grid two">
          <article class="card community-card"><h3>Participation</h3><p>Be constructive, respectful, and transparent when representing the project.</p></article>
          <article class="card community-card"><h3>Recognition and rewards</h3><p>Approved participants may qualify for milestone-based LDX rewards or other programme benefits, subject to eligibility, verification, available budget, and approval. Applying does not guarantee selection or rewards.</p></article>
        </div>
      </section>
      <section class="community-section community-bottom-cta">${sectionHeading('Interested in becoming an ambassador?', 'Selected participants may qualify for programme benefits or milestone-based rewards, subject to eligibility, verification, available budget, and approval. Applying does not guarantee a reward or selection.')}
        ${formLink('ambassador', 'Ambassador application', 'btn')}</section>`;
  }

  function developerPage() {
    return `<div class="eyebrow">Community programs</div><h1 class="community-page-title">Build on Lidex</h1>
      <p class="community-page-lede">Lidex welcomes developers and technical contributors working on applications, infrastructure, smart contracts, developer tools, wallets, testing, and documentation.</p>
      <section class="community-section">${sectionHeading('Areas to contribute')}
        <div class="community-chip-list">${['Blockchain development', 'Smart contracts', 'Frontend and backend', 'Wallet integration', 'Explorer and tooling', 'Security and testing', 'Documentation'].map((item) => `<span class="community-chip">${item}</span>`).join('')}</div>
      </section>
      <section class="community-section">${sectionHeading('Support and rewards')}
        <p class="community-policy-copy">Approved contributors may qualify for milestone-based rewards, LDX incentives, technical support, collaboration, or development support. Eligibility, milestones, available budget, and approval apply; no reward or grant is guaranteed.</p>
      </section>
      <section class="community-section community-bottom-cta">${sectionHeading('Interested in building on Lidex?', 'The Typeform destination is a placeholder until the official link is provided.')}
        ${formLink('developer', 'Developer application', 'btn')}</section>`;
  }

  function validatorsPage() {
    return `<div class="eyebrow">Network participation</div><h1 class="community-page-title">Validator Interest</h1>
      <p class="community-page-lede">Lidex welcomes individuals and organisations interested in supporting the security, reliability, and decentralisation of its blockchain network.</p>
      <section class="community-section">${emptyState('Express interest in becoming a validator', 'This is an expression of interest only. It does not guarantee validator approval, network access, or staking rewards. Technical requirements will be shared when available.')}</section>
      <section class="community-section community-bottom-cta">${sectionHeading('Share your validator interest', 'The Typeform destination is a placeholder until the official link is provided. Never share private keys, wallet passwords, or recovery phrases.')}
        ${formLink('validator', 'Validator interest form', 'btn')}</section>`;
  }

  function partnershipsPage() {
    return `<div class="eyebrow">Ecosystem collaboration</div><h1 class="community-page-title">Partner with Lidex</h1>
      <p class="community-page-lede">Lidex welcomes organisations, businesses, blockchain projects, communities, and service providers interested in working together.</p>
      <section class="community-section">${sectionHeading('Explore collaboration')}
        <div class="community-chip-list">${['Technology integration', 'Community collaboration', 'Marketing and media', 'Ecosystem integration', 'Education', 'Events', 'Business partnerships'].map((item) => `<span class="community-chip">${item}</span>`).join('')}</div>
      </section>
      <section class="community-section community-bottom-cta">${sectionHeading('Propose a partnership', 'Share your organisation and collaboration idea through the Typeform when the official URL is provided. A submission does not guarantee acceptance.')}
        ${formLink('partnership', 'Partnership application', 'btn')}</section>`;
  }

  function eventsPage() {
    return `<div class="eyebrow">Community</div><h1 class="community-page-title">Events</h1>
      <p class="community-page-lede">Find Lidex community calls, workshops, developer sessions, and local meetups. Event dates and registration are not connected to this site.</p>
      <div class="community-chip-list" aria-label="Event types">${['Community calls', 'Workshops', 'Developer sessions', 'Local meetups'].map((label) => `<span class="community-chip">${label}</span>`).join('')}</div>
      <section class="community-section">${emptyState('No upcoming events published', 'No dates or registration links are currently available. Follow official Lidex channels for announcements.')}</section>
      <section class="community-section community-bottom-cta">${sectionHeading('Register for an event', 'Event dates and registration are not available yet. The registration Typeform link will be added when provided.')}
        ${formLink('eventRegistration', 'Register for an Event', 'btn')}</section>`;
  }

  function grantsPage() {
    const areas = ['Core protocol and infrastructure', 'Developer tooling and integrations', 'Documentation and education', 'Community-led ecosystem projects'];
    return `<div class="eyebrow">Ecosystem programs</div><h1 class="community-page-title">Grants &amp; Programs</h1>
      <p class="community-page-lede">Lidex may support useful work across the ecosystem. This page describes areas of interest only; it does not announce an active grant round or promise funding.</p>
      <section class="community-section">${sectionHeading('Areas of interest')}
        <div class="community-grid two">${areas.map((area) => `<article class="card community-card"><div class="community-icon" aria-hidden="true">＋</div><h3>${area}</h3><p>Project proposals in this area can be shared for consideration when an official program is available.</p></article>`).join('')}</div>
      </section>
      <section class="community-section">${emptyState('No active grant round announced', 'No funding pool, application deadline, award, or grant decision is published here. Approved projects may qualify for support when a programme and its requirements are announced.')}</section>
      <section class="community-section community-bottom-cta">${sectionHeading('Share a project idea', 'Approved projects may qualify for ecosystem funding or milestone-based support, subject to programme eligibility, verification, available budget, and approval. Submission does not guarantee funding.')}
        ${formLink('grant', 'Grant interest form', 'btn')}</section>`;
  }

  function contributorsPage() {
    const work = ['Protocol and client development', 'Developer tools and integrations', 'Documentation and tutorials', 'Testing and quality', 'Community and translations'];
    return `<div class="eyebrow">Community</div><h1 class="community-page-title">Contributors</h1>
      <p class="community-page-lede">Lidex benefits from people who build, document, test, and support the ecosystem. This page is informational; it is not a contributor directory or activity tracker.</p>
      <section class="community-section">${sectionHeading('Ways to contribute')}
        <div class="community-chip-list">${work.map((item) => `<span class="community-chip">${item}</span>`).join('')}</div>
      </section>
      <section class="community-section">${emptyState('Public contributor profiles are not available', 'No names, rankings, badges, activity counts, or contribution totals are displayed because a verified directory is not connected.')}</section>
      <p class="community-policy-copy">Verified contributions may qualify for recognition or approved LDX rewards, subject to programme eligibility, verification, available budget, and approval. Applying or contributing does not guarantee a reward.</p>
      <section class="community-section community-bottom-cta">${sectionHeading('Want to contribute?', 'Use this placeholder interest button when the official Typeform link is ready, or start a conversation in Telegram.')}
        <div class="community-actions">${formLink('contributor', 'Contributor interest', 'btn')}${socialLink('telegram', 'Join Telegram', 'btn ghost')}</div></section>`;
  }

  function helpPage() {
    const faq = [
      ['What is the Lidex community site?', 'These are static information pages. They do not have accounts, a forum backend, application processing, or data storage.'],
      ['Where can I talk with the community?', `Use the official Telegram channel: ${links.telegram}. Public discussion links are also provided on the Discussions page.`],
      ['How do I apply to a program?', 'Application buttons are prepared, but their Typeform URLs are placeholders. No application is submitted or stored until official destinations are configured.'],
      ['Is a governance vote happening here?', 'No. The website does not accept or count votes. Any official governance process will be announced separately.'],
      ['Are grant funds or ambassador rewards guaranteed?', 'No. Approved participants may qualify for LDX rewards, milestone support, recognition, or grants depending on the programme. Eligibility, verification, available budget, and approval apply. Applying does not guarantee a reward.'],
      ['How do I get help with the network?', 'Use the Contact Support button or review the Lidex public channels. The support form destination will be added when the official Typeform URL is provided. Never send passwords, private keys, or recovery phrases.'],
      ['How is my application information used?', 'When the external Typeform links are configured, each relevant form should include the privacy and consent statement supplied in the Lidex application-form brief. This website does not collect or store applications.'],
    ];
    return `<div class="eyebrow">Community</div><h1 class="community-page-title">Help Center</h1>
      <p class="community-page-lede">Quick answers about Lidex community channels, programs, and what this static website can and cannot do.</p>
      <div class="community-faq-search"><label for="communityFaqSearch">Search help topics</label><input id="communityFaqSearch" type="search" placeholder="Search a question or keyword" autocomplete="off"></div>
      <div class="community-faq-list">${faq.map(([question, answer]) => `<details data-community-faq><summary>${question}</summary><p>${answer}</p></details>`).join('')}</div>
      <p id="communityFaqEmpty" class="community-status-note" hidden>No help topics match that search.</p>
      <section class="community-section community-bottom-cta">${sectionHeading('Still need help?', 'Support form URL is a placeholder until the official Typeform destination is provided.')}
        <div class="community-actions">${formLink('support', 'Contact Support', 'btn')}<a class="btn ghost" href="https://t.me/lidexblockchain" target="_blank" rel="noopener noreferrer">Telegram @lidexblockchain</a></div></section>`;
  }

  const pageRenderers = {
    home: homePage,
    programs: programsPage,
    announcements: announcementsPage,
    discussions: discussionsPage,
    governance: governancePage,
    ambassadors: ambassadorsPage,
    developers: developerPage,
    validators: validatorsPage,
    partnerships: partnershipsPage,
    events: eventsPage,
    grants: grantsPage,
    contributors: contributorsPage,
    help: helpPage,
  };

  function render(path) {
    const renderer = pageRenderers[path];
    const content = renderer
      ? renderer()
      : `<div class="community-empty"><h1>Community page not found</h1><p>The requested community page does not exist.</p><a class="btn ghost" href="#/community">Back to Community</a></div>`;
    const nav = sections.map(([route, label]) =>
      `<a href="#/community${route === 'home' ? '' : `/${route}`}"${route === path ? ' class="active" aria-current="page"' : ''}>${label}</a>`,
    ).join('');
    return `<div class="community-wrap"><nav class="community-nav" aria-label="Community sections">${nav}</nav>${content}
      <div class="community-form-notice" id="communityFormNotice" role="status" aria-live="polite" hidden></div>
      <footer class="community-section community-muted"><div class="row between"><span>Lidex Community · Independent. Open. Built to last.</span>
        <nav class="social-links" aria-label="Social media">
          ${socialIconLink('x', 'X', 'M18.9 2H22l-6.78 7.75L23.2 22h-6.25l-4.9-7.45L5.52 22H2.4l7.25-8.29L1.8 2h6.4l4.43 6.78L18.9 2Zm-1.1 18h1.73L7.28 3.9H5.42L17.8 20Z')}
          ${socialIconLink('telegram', 'Telegram', 'M21.9 4.2 18.6 20c-.25 1.12-.91 1.4-1.85.87l-5.1-3.76-2.46 2.37c-.27.27-.5.5-1.03.5l.37-5.2 9.46-8.55c.41-.37-.09-.57-.64-.2L5.66 13.4.62 11.83c-1.1-.34-1.12-1.1.23-1.63L20.56 2.6c.91-.34 1.71.22 1.34 1.6Z')}
          ${socialIconLink('linkedin', 'LinkedIn', 'M20.45 2H3.55C2.69 2 2 2.68 2 3.53v16.94c0 .85.69 1.53 1.55 1.53h16.9c.86 0 1.55-.68 1.55-1.53V3.53c0-.85-.69-1.53-1.55-1.53ZM8.06 18.74H5.12V9.25h2.94v9.49ZM6.59 7.95a1.7 1.7 0 1 1 0-3.4 1.7 1.7 0 0 1 0 3.4Zm12.15 10.79H15.8v-4.62c0-1.1-.02-2.51-1.53-2.51-1.53 0-1.76 1.2-1.76 2.43v4.7H9.58V9.25h2.82v1.3h.04c.39-.74 1.35-1.53 2.78-1.53 2.97 0 3.52 1.95 3.52 4.49v5.23Z')}
          ${socialIconLink('youtube', 'YouTube', 'M23.5 6.2a3.02 3.02 0 0 0-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.51A3.02 3.02 0 0 0 .5 6.2 31.4 31.4 0 0 0 0 12a31.4 31.4 0 0 0 .5 5.8 3.02 3.02 0 0 0 2.12 2.14c1.88.51 9.38.51 9.38.51s7.5 0 9.38-.51a3.02 3.02 0 0 0 2.12-2.14A31.4 31.4 0 0 0 24 12a31.4 31.4 0 0 0-.5-5.8ZM9.55 15.58V8.42L15.82 12l-6.27 3.58Z')}
        </nav></div>
        <p class="community-status-note">Community pages are informational only. No account data, applications, votes, or submissions are collected here.</p>
      </footer></div>`;
  }

  document.addEventListener('click', (event) => {
    const anchor = event.target.closest('a[data-community-form]');
    if (!anchor || links.forms[anchor.dataset.communityForm]) return;
    event.preventDefault();
    const notice = document.getElementById('communityFormNotice');
    if (notice) {
      notice.textContent = 'This form link is a placeholder. Lidex will add the official Typeform URL when it is available.';
      notice.hidden = false;
      notice.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });

  window.LidexCommunity = {
    render,
    activate() {
      const search = document.getElementById('communityFaqSearch');
      if (!search) return;
      const items = [...document.querySelectorAll('[data-community-faq]')];
      const empty = document.getElementById('communityFaqEmpty');
      search.addEventListener('input', () => {
        const query = search.value.trim().toLowerCase();
        let visible = 0;
        items.forEach((item) => {
          const matches = item.textContent.toLowerCase().includes(query);
          item.hidden = !matches;
          if (matches) visible += 1;
        });
        empty.hidden = visible > 0;
      });
    },
  };
}());
