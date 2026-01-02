import { BlinkoCard } from "@/components/BlinkoCard";
import { api } from "@/lib/trpc";
import { RootStore } from "@/store";
import { PromiseState } from "@/store/standard/PromiseState";
import { observer } from "mobx-react-lite";
import { useEffect, useState } from "react";
import { useMediaQuery } from "usehooks-ts";
import { Card, InputOtp, Button } from "@heroui/react";
import { Icon } from '@/components/Common/Iconify/icons';
import { useTranslation } from "react-i18next";
import { useLocation, useSearchParams, useParams } from 'react-router-dom';
import { GradientBackground } from '@/components/Common/GradientBackground';


const Page: React.FC = observer(() => {
  const isPc = useMediaQuery('(min-width: 768px)')
  const { t } = useTranslation()
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [isExpired, setIsExpired] = useState(false);
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { id } = useParams();

  const store = RootStore.Local(() => ({
    shareNote: new PromiseState({
      function: async (shareEncryptedUrl: string, password?: string) => {
        try {
          const notes = await api.notes.publicDetail.mutate({ shareEncryptedUrl, password })
          if (notes.error === 'expired') {
            setIsExpired(true);
            return null;
          }
          if (notes.hasPassword && !password) {
            setHasPassword(true);
            return null;
          }
          return notes.data;
        } catch (e) {
          setError(true);
          return null;
        }
      }
    })
  }))

  useEffect(() => {
    if (!id) return
    const urlPassword = searchParams.get('password') as string;
    if (urlPassword) {
      setPassword(urlPassword);
      store.shareNote.call(id, urlPassword);
    } else {
      store.shareNote.call(id);
    }
  }, [location.pathname, id, searchParams.get('password')])


  const handleVerify = () => {
    setError(false);
    store.shareNote.call(id as string, password);
  };

  if (isExpired) {
    return (
      <GradientBackground>
        <div className='p-4 h-[100vh] w-full flex justify-center items-center'>
          <Card className="p-6 flex flex-col gap-4 items-center glass-effect">
            <div className="flex items-center gap-2">
              <Icon icon="solar:clock-circle-bold" className="text-2xl text-danger" />
              <span className="text-xl font-medium text-danger">{t("share-link-expired")}</span>
            </div>
            <p className="text-sm text-default-500">{t("share-link-expired-desc")}</p>
          </Card>
        </div>
      </GradientBackground>
    );
  }

  if (hasPassword && !store.shareNote?.value) {
    return (
      <GradientBackground>
        <div className='p-4 h-[100vh] w-full flex justify-center items-center'>
          <Card className="p-6 flex flex-col gap-4 items-center glass-effect">
            <div className="flex items-center gap-2">
              <Icon icon="solar:lock-password-bold" className="text-2xl" />
              <span className="text-xl font-medium">{t("need-password-to-access")}</span>
            </div>
            <InputOtp
              length={6}
              value={password}
              onValueChange={setPassword}
              onComplete={handleVerify}
              classNames={{
                input: error ? "border-danger" : ""
              }}
            />
            {error && <span className="text-danger text-sm">{t("password-error")}</span>}
            <Button
              color="primary"
              className="w-full"
              onPress={handleVerify}
              isDisabled={password.length !== 6}
            >
              {t("verify")}
            </Button>
          </Card>
        </div>
      </GradientBackground>
    );
  }

  return (
    <GradientBackground>
      <div className='p-4 h-[100vh] w-full flex justify-center items-center'>
        {store.shareNote?.value && (
          <div className="glass-effect max-h-[90vh] overflow-y-scroll w-[95%] md:min-w-[30%] md:max-w-[50%] rounded-xl shadow-[1px_0_25px_11px_rgba(98,0,114,0.17)]">
            <BlinkoCard blinkoItem={store.shareNote?.value} isShareMode glassEffect defaultExpanded={true} />
          </div>
        )}
      </div>
    </GradientBackground>
  );
});

export default Page