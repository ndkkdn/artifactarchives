/* Artifact Archives — 방문자 제출
 *
 * 누구나 아티팩트를 제안할 수 있어요. 사이트에는 서버가 없으므로, 이 양식은 내용을 채운
 * GitHub 이슈 작성 화면(.github/ISSUE_TEMPLATE/submit-artifact.yml)을 새 탭으로 엽니다.
 * 제출자는 GitHub에 로그인해 [Create]를 누르면 끝. 관리자는 관리 모드의 "제출" 목록에서
 * 검토하고 승인하면 아카이브에 올라갑니다. 링크만 받으므로 남의 HTML이 이 사이트 주소에서
 * 실행될 일은 없어요.
 */
(() => {
  const REPO = 'ndkkdn/artifactarchives';
  const TEMPLATE = 'submit-artifact.yml';
  const A = window.Archive, esc = A.esc;

  if (!document.querySelector('link[href="dialog.css"]')) {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = 'dialog.css'; document.head.appendChild(link);
  }

  function open() {
    const types = [...new Set(A.items.map(i => i.type))];
    const d = document.createElement('dialog'); d.className = 'adm-dialog';
    d.innerHTML = `
      <form method="dialog" novalidate>
        <div class="adm-head"><h3>아티팩트 제출</h3>
          <p>공개된 페이지의 링크를 알려 주세요. 관리자가 확인한 뒤 아카이브에 올려요.
          [GitHub에서 제출]을 누르면 내용이 채워진 GitHub 이슈 작성 화면이 열려요. GitHub 계정으로 로그인해 마무리해 주세요.</p></div>
        <div class="adm-body">
          <label class="adm-field full"><span>제목 <b>*</b></span><input type="text" name="title" required maxlength="120"></label>
          <label class="adm-field"><span>종류 <b>*</b></span><input type="text" name="type" list="sub-types" required maxlength="30" placeholder="슬라이드, 가이드…">
            <datalist id="sub-types">${types.map(t => `<option value="${esc(t)}">`).join('')}</datalist></label>
          <label class="adm-field"><span>만든 사람</span><input type="text" name="author" maxlength="60" placeholder="선택"></label>
          <label class="adm-field full"><span>링크 <b>*</b></span><input type="text" name="url" required inputmode="url" placeholder="https://"></label>
          <label class="adm-field full"><span>설명</span><textarea name="desc" maxlength="600" placeholder="아카이브 카드에 보일 한두 문장"></textarea></label>
          <label class="adm-field full"><span>태그</span><input type="text" name="tags" maxlength="120" placeholder="쉼표로 구분"></label>
          <p class="adm-err"></p>
        </div>
        <div class="adm-foot"><button type="button" class="pill" data-close>취소</button><button type="submit" class="pill primary">GitHub에서 제출 ↗</button></div>
      </form>`;
    document.body.appendChild(d);
    const nativeClose = d.close.bind(d);
    d.close = () => { if (d.open) nativeClose(); d.remove(); };
    d.addEventListener('close', () => d.remove());
    d.addEventListener('click', e => { if (e.target === d) d.close(); });
    d.querySelector('[data-close]').onclick = () => d.close();
    d.showModal();

    const f = d.querySelector('form'), err = d.querySelector('.adm-err');
    f.addEventListener('submit', e => {
      e.preventDefault();
      const v = k => f.elements[k].value.trim();
      err.textContent = '';
      if (!v('title')) return void (err.textContent = '제목을 입력해 주세요.');
      if (!v('type')) return void (err.textContent = '종류를 입력해 주세요.');
      let u;
      try { u = new URL(v('url')); } catch (_) {}
      if (!u || !/^https?:$/.test(u.protocol)) return void (err.textContent = 'http:// 또는 https:// 로 시작하는 주소를 입력해 주세요.');
      // issue-form fields are prefilled by their ids
      const q = new URLSearchParams({
        template: TEMPLATE,
        title: `[제출] ${v('title')}`,
        'artifact-title': v('title'),
        'artifact-type': v('type'),
        'artifact-url': u.href,
        'artifact-desc': v('desc'),
        'artifact-tags': v('tags'),
        'artifact-author': v('author'),
      });
      const target = `https://github.com/${REPO}/issues/new?${q}`;
      // ('noopener' would make window.open return null, so detach the opener by hand)
      const win = window.open(target, '_blank');
      d.close();
      if (win) win.opener = null; else location.href = target;
    });
  }

  window.ArchiveSubmit = { open };
  open();
})();
