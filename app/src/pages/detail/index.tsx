import { ScrollArea } from "@/components/Common/ScrollArea";
import { RootStore } from "@/store";
import { BlinkoStore } from "@/store/blinkoStore";
import { _ } from "@/lib/lodash";
import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { useLocation, useSearchParams } from 'react-router-dom';
import { BlinkoCard } from "@/components/BlinkoCard";
import { LoadingAndEmpty } from "@/components/Common/LoadingAndEmpty";

const Detail = observer(() => {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const blinko = RootStore.Get(BlinkoStore);

  useEffect(() => {
    if (searchParams.get('id')) {
      blinko.noteDetail.call({ id: Number(searchParams.get('id')) });
    }
  }, [location.pathname, searchParams.get('id'), blinko.updateTicker, blinko.forceQuery]);

  return (
    <ScrollArea fixMobileTopBar reserveMobileBottomBar>
      <div className="max-w-[800px] mx-auto p-4">
        <LoadingAndEmpty
          isLoading={blinko.noteDetail.loading.value}
          isEmpty={!blinko.noteDetail.value}
        />

        {blinko.noteDetail.value && (
          <BlinkoCard
            blinkoItem={blinko.noteDetail.value}
            defaultExpanded={false}
            glassEffect={false}
          />
        )}
      </div>
    </ScrollArea>
  );
});

export default Detail;