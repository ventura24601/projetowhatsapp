import { useState } from "react";
import { supabase } from "../api.js";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("login");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const fn = mode === "login" ? supabase.auth.signInWithPassword : supabase.auth.signUp;
    const { error, data } = await fn.call(supabase.auth, { email, password });
    setBusy(false);
    if (error) setMsg(error.message);
    else if (mode === "signup" && !data.session) setMsg("Conta criada. Confirme pelo e-mail recebido e depois entre.");
  }

  return (
    <div className="login">
      <form className="card form" onSubmit={submit}>
        <h1>Monitor WhatsApp</h1>
        <p className="hint">Tempo de resposta e análise do atendimento nos grupos.</p>
        <label>E-mail<input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Senha<input className="input" type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {msg && <div className="error">{msg}</div>}
        <button className="btn" disabled={busy}>{busy ? "Aguarde…" : mode === "login" ? "Entrar" : "Criar conta"}</button>
        <button type="button" className="btn ghost" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
          {mode === "login" ? "Primeiro acesso? Criar conta" : "Já tenho conta"}
        </button>
      </form>
    </div>
  );
}
