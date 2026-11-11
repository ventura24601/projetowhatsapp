import { useState } from "react";
import { supabase } from "../api.js";
import { ErrorBox, Modal } from "../components/ui.jsx";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setMsg(/invalid/i.test(error.message) ? "E-mail ou senha incorretos." : error.message);
  }

  return (
    <div className="login">
      <form className="card form" onSubmit={submit}>
        <h1>Monitor WhatsApp</h1>
        <p className="hint">Tempo de resposta e análise do atendimento nos grupos.</p>
        <label>E-mail<input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Senha<input className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {msg && <div className="error">{msg}</div>}
        <button className="btn" disabled={busy}>{busy ? "Aguarde…" : "Entrar"}</button>
        <p className="hint">Sem acesso ou esqueceu a senha? Peça a um administrador do painel.</p>
      </form>
    </div>
  );
}

export function NoAccess({ email }) {
  return (
    <div className="login">
      <div className="card form">
        <h1>Sem acesso</h1>
        <p className="hint">
          A conta {email ? <b>{email}</b> : "usada"} não está cadastrada no painel. Peça a um administrador para
          cadastrar você em Configurações → Usuários.
        </p>
        <button className="btn" onClick={() => supabase.auth.signOut()}>Sair</button>
      </div>
    </div>
  );
}

export function ChangePassword({ onClose }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    if (pw !== pw2) return setErr("As senhas não conferem.");
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) setErr(error.message);
    else setOk(true);
  }
  return (
    <Modal title="Trocar minha senha" onClose={onClose}>
      {ok ? (
        <div className="form">
          <p className="callout">Senha alterada. ✅</p>
          <div className="form-actions"><button className="btn" onClick={onClose}>Fechar</button></div>
        </div>
      ) : (
        <form className="form" onSubmit={save}>
          <ErrorBox error={err} />
          <label>Nova senha<input className="input" type="password" required minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} /></label>
          <label>Repita a nova senha<input className="input" type="password" required minLength={8} value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
          <div className="form-actions"><button className="btn" disabled={busy}>{busy ? "Salvando…" : "Salvar"}</button></div>
        </form>
      )}
    </Modal>
  );
}
