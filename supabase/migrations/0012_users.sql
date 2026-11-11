-- Cadastro de usuários pela plataforma: só quem um admin cadastrou tem acesso.
alter table public.user_roles add column if not exists name text;

-- whoami não cria mais acesso automático (exceto o primeiro admin, quando não há ninguém).
create or replace function public.whoami()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_role text; v_name text; v_email text := auth.jwt() ->> 'email';
begin
  if auth.uid() is null then
    raise exception 'Acesso negado: faça login.' using errcode = '42501';
  end if;
  select role, name into v_role, v_name from user_roles where user_id = auth.uid();
  if v_role is null and not exists (select 1 from user_roles) then
    v_role := 'admin';
    insert into user_roles (user_id, email, role) values (auth.uid(), v_email, v_role)
    on conflict (user_id) do nothing;
  elsif v_role is not null and v_email is not null then
    update user_roles set email = v_email where user_id = auth.uid() and email is distinct from v_email;
  end if;
  return jsonb_build_object('user_id', auth.uid(), 'email', v_email, 'name', v_name, 'role', v_role);
end $$;

-- Grava/atualiza o acesso de um usuário (chamada pelo servidor depois de criar o login).
create or replace function public.user_save(p_user uuid, p_email text, p_name text, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_role not in ('admin', 'viewer') then raise exception 'Papel inválido'; end if;
  insert into public.user_roles (user_id, email, name, role)
  values (p_user, lower(p_email), nullif(trim(p_name), ''), p_role)
  on conflict (user_id) do update
    set email = excluded.email, name = coalesce(excluded.name, user_roles.name), role = excluded.role;
end $$;

create or replace function public.user_remove(p_user uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.user_roles where user_id = p_user;
$$;

-- Admin pode renomear pelo painel.
create or replace function public.set_user_name(p_user uuid, p_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  update public.user_roles set name = nullif(trim(p_name), '') where user_id = p_user;
end $$;
