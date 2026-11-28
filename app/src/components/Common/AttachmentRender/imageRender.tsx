import { useEffect, useMemo, useState } from 'react';
import { FileType } from '../Editor/type';
import { Image } from '@heroui/react';
import { PhotoProvider, PhotoView } from 'react-photo-view';
import { Icon } from '@/components/Common/Iconify/icons';
import { DeleteIcon, DownloadIcon, InsertConextButton, CopyIcon } from './icons';
import { observer } from 'mobx-react-lite';
import { useMediaQuery } from 'usehooks-ts';
import { DraggableFileGrid } from './DraggableFileGrid';
import axiosInstance from '@/lib/axios';
import { getBlinkoFileUrl } from '@/lib/blinkoEndpoint';
import { RootStore } from '@/store';
import { UserStore } from '@/store/user';

type IProps = {
  files: FileType[]
  preview?: boolean
  columns?: number
  onReorder?: (newFiles: FileType[]) => void
}
export const ImageThumbnailRender = ({ src, className }: { src: string, className?: string }) => {
  const [isOriginalError, setIsOriginalError] = useState(false);
  const [currentSrc, setCurrentSrc] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let objectUrl = '';

    const fetchImage = async () => {
      setLoading(true);
      try {
        // Try to get thumbnail first
        const response = await axiosInstance.get(getBlinkoFileUrl(src, { thumbnail: true }), {
          responseType: 'blob'
        });

        objectUrl = URL.createObjectURL(response.data);
        setCurrentSrc(objectUrl);
      } catch (error) {
        try {
          // If thumbnail fails, try original image
          const response = await axiosInstance.get(getBlinkoFileUrl(src), {
            responseType: 'blob'
          });

          objectUrl = URL.createObjectURL(response.data);
          setCurrentSrc(objectUrl);
        } catch (error) {
          // If both fail, use fallback
          setIsOriginalError(true);
        }
      } finally {
        setLoading(false);
      }
    };

    fetchImage();

    // Clean up created object URLs when component unmounts
    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [src]);

  useEffect(() => {
    if (isOriginalError) {
      setCurrentSrc('/image-fallback.svg')
    }
  }, [isOriginalError])

  return (
    <>
      {loading && (
        <div className="flex items-center justify-center w-full h-full">
          <Icon icon="line-md:loading-twotone-loop" width="24" height="24" />
        </div>
      )}
      {!loading && (
        <Image
          src={currentSrc}
          classNames={{
            wrapper: '!max-w-full',
          }}
          draggable={false}
          onError={() => {
            setIsOriginalError(true);
          }}
          className={`object-cover w-full ${className}`}
        />
      )}
    </>
  );
}

const ImageRender = observer((props: IProps) => {
  const { files, preview = false, columns } = props
  const isPc = useMediaQuery('(min-width: 768px)')

  const imageRenderClassName = useMemo(() => {
    if (!preview) {
      return 'flex flex-row gap-2 overflow-x-auto pb-2'
    }
    return 'flex flex-wrap gap-2'
  }, [preview, columns])

  const imageHeight = useMemo(() => {
    if (!preview) {
      return 'h-[160px] w-[160px]'
    }
    return 'md:h-[180px] md:w-[180px] h-[100px] w-[100px] object-cover'
  }, [preview, columns])

  const renderImage = (file: FileType) => (
    <div className={`relative group ${!preview ? 'min-w-[160px] flex-shrink-0' : ''} ${imageHeight}`}>
      {file.uploadPromise?.loading?.value && (
        <div className='absolute inset-0 flex items-center justify-center w-full h-full'>
          <Icon icon="line-md:uploading-loop" width="40" height="40" />
        </div>
      )}
      <div className='w-full'>
        <PhotoView src={getBlinkoFileUrl(file.preview, { token: RootStore.Get(UserStore).tokenData.value?.token })}>
          <div>
            <ImageThumbnailRender
              src={file.preview}
              className={`mb-4 ${imageHeight} object-cover md:w-[1000px]`}
            />
          </div>
        </PhotoView>
      </div>
      {!file.uploadPromise?.loading?.value && !preview &&
        <InsertConextButton className='absolute z-10 left-[5px] top-[5px]' files={files} file={file} />
      }
      {!file.uploadPromise?.loading?.value && !preview &&
        <DeleteIcon className='absolute z-10 right-[5px] top-[5px]' files={files} file={file} />
      }
      {preview && (
        <>
          <CopyIcon file={file} />
          <DownloadIcon file={file} />
        </>
      )}
    </div>
  )

  return (
    <PhotoProvider>
      <DraggableFileGrid
        files={files}
        preview={preview}
        columns={columns}
        type="image"
        className={imageRenderClassName}
        renderItem={renderImage}
        onReorder={props.onReorder}
      />
    </PhotoProvider>
  )
})

export { ImageRender }