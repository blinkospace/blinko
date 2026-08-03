import { api } from "@/lib/trpc";
import { RootStore } from "@/store";
import { DialogStore } from "@/store/module/Dialog";
import { PromiseCall } from "@/store/standard/PromiseState";
import { UserStore } from "@/store/user";
import { Button, Input } from "@heroui/react";
import { observer } from "mobx-react-lite";
// import { signOut } from "next-auth/react";
import { useNavigate } from "react-router-dom";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PasswordInput } from "./PasswordInput";
import { eventBus } from "@/lib/event";
import { preparePasswordUpdate } from "./preparePasswordUpdate";
import { ToastPlugin } from "@/store/module/Toast/Toast";

export const UpdateUserInfo = observer(() => {
  const user = RootStore.Get(UserStore)
  const { t } = useTranslation()
  const navigate = useNavigate()
  const store = RootStore.Local(() => ({
    username: '',
    nickname: '',
    originalPassword: ''
  }))
  useEffect(() => {
    store.username = user.name!
    store.nickname = user.nickname!
  }, [user.name, user.nickname])

  return <>
    <Input
      label={t('username')}
      labelPlacement="outside"
      variant="bordered"
      value={store.username}
      onChange={e => { store.username = e.target.value }}
    />
    <Input
      label={t('nickname')}
      variant="bordered"
      labelPlacement="outside"
      value={store.nickname}
      onChange={e => { store.nickname = e.target.value }}
    />
    <PasswordInput
      label={t('original-password')}
      placeholder={t('enter-your-password')}
      value={store.originalPassword}
      onChange={e => { store.originalPassword = e.target.value }}
    />
    <div className="flex w-full mt-2">
      <Button className="ml-auto" color='primary' onPress={async e => {
        const updated = await PromiseCall(api.users.upsertUser.mutate({ id: Number(user.id), name: store.username, nickname: store.nickname, originalPassword: store.originalPassword }))
        if (!updated) return
        RootStore.Get(DialogStore).close()
        eventBus.emit('user:signout')
        navigate('/signin')
      }}>{t('save')}</Button>
    </div>
  </>
})


export const UpdateUserPassword = observer(() => {
  const user = RootStore.Get(UserStore)
  const { t } = useTranslation()
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [originalPassword, setOriginalPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false)
  const navigate = useNavigate()

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const prepared = preparePasswordUpdate(Number(user.id), originalPassword, password, passwordConfirm)
    if ('error' in prepared) {
      const messageKey = prepared.error === 'required'
        ? 'required-items-cannot-be-empty'
        : 'the-two-passwords-are-inconsistent'
      RootStore.Get(ToastPlugin).error(t(messageKey))
      return
    }

    setIsSubmitting(true)
    try {
      const updated = await PromiseCall(api.users.upsertUser.mutate(prepared.input))
      if (!updated) return

      RootStore.Get(DialogStore).close()
      eventBus.emit('user:signout')
      navigate('/signin')
    } finally {
      setIsSubmitting(false)
    }
  }

  return <>
    <form className="flex w-full mt-2 flex-col gap-2" onSubmit={handleSubmit}>
      <PasswordInput placeholder={t('enter-your-password')} label={t('original-password')} value={originalPassword} onChange={e => setOriginalPassword(e.target.value)} />
      <PasswordInput placeholder={t('enter-your-password')} label={t('password')} value={password} onChange={e => setPassword(e.target.value)} />
      <PasswordInput placeholder={t('enter-your-password')} label={t('confirm-password')} value={passwordConfirm} onChange={e => setPasswordConfirm(e.target.value)} />
      <div className="flex w-full justify-end">
        <Button className="ml-auto" color='primary' isLoading={isSubmitting} type="submit">{t('save')}</Button>
      </div>
    </form>
  </>
})
