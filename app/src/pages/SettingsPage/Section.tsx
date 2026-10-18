import SectionHeading from '@components/SectionHeading';
import { PropsWithChildren, useId } from 'react';
import { Card, CardContent } from '@mui/material';



type SectionProps = PropsWithChildren<{
  title?: string;
}>;

export default function Section({ title, children }: SectionProps) {
  const headingId = useId();
  return (
    <Card
      component={ title ? 'section' : 'div' }
      aria-labelledby={ title ? headingId : undefined }
      sx={ { width: '100%', overflowWrap: 'break-word', wordBreak: 'break-word' } }>
      <CardContent>
        {
          title && (
            <>
              <SectionHeading id={ headingId } sx={ { textAlign: 'left', mb: 1.5 } }>
                { title }
              </SectionHeading>
            </>
          )
        }
        { children }
      </CardContent>
    </Card>
  );
}
