import {
  Accordion,
  AccordionSummary,
  Box,
  Button,
  ToggleButton,
  AccordionDetails,
  Typography
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { AccordionExpanded } from './SchedulePage.types.ts';
import { DayOfWeek } from '@api/schedulesSchema.ts';
import { useAppStore } from '@state/appStore.tsx';
import { useScheduleStore } from './scheduleStore';
import { dayChipSx } from './dayChipSx';

export const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ACCORDION_NAME: AccordionExpanded = 'applyToDays';

export default function ApplyToOtherDaysAccordion() {
  const {
    selectedDays,
    toggleSelectedDay,
    accordionExpanded,
    setAccordionExpanded,
  } = useScheduleStore();
  const { isUpdating } = useAppStore();

  // Only turn a day ON if it isn't already selected, so these buttons are
  // idempotent: clicking "Weekdays" twice, or after manually checking one
  // weekday, always ends with every weekday selected instead of flipping
  // already-checked days back off.
  const setWeekdays = () => {
    // daysOfWeek is Sunday-first, so Monday-Friday is indices 1 through 5.
    daysOfWeek.slice(1, 6).map(day => {
      const lowerCaseDay = day.toLowerCase() as DayOfWeek;
      if (!selectedDays[lowerCaseDay]) toggleSelectedDay(lowerCaseDay);
    });
  };

  const setEveryday = () => {
    daysOfWeek.map(day => {
      const lowerCaseDay = day.toLowerCase() as DayOfWeek;
      if (!selectedDays[lowerCaseDay]) toggleSelectedDay(lowerCaseDay);
    });
  };

  const setWeekends= () => {
    // daysOfWeek is Sunday-first: Sunday is index 0, Saturday is index 6.
    const sunday = daysOfWeek[0].toLowerCase() as DayOfWeek;
    const saturday = daysOfWeek[6].toLowerCase() as DayOfWeek;
    if (!selectedDays[saturday]) toggleSelectedDay(saturday);
    if (!selectedDays[sunday]) toggleSelectedDay(sunday);
  };

  return (
    <Accordion
      sx={ { width: '100%' } }
      expanded={ accordionExpanded === ACCORDION_NAME }
      onChange={ () => setAccordionExpanded(ACCORDION_NAME) }
    >
      <AccordionSummary expandIcon={ <ExpandMoreIcon/> }>
        <Typography component="span" variant="inherit">Apply settings to other days</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Box sx={ { display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1, ml: -1 } }>
          <Button onClick={ setWeekdays }>Weekdays</Button>
          <Button onClick={ setWeekends }>Weekends</Button>
          <Button onClick={ setEveryday }>Every day</Button>
        </Box>
        <Box role="group" aria-label="Apply to days" sx={ { display: 'flex', flexWrap: 'wrap', gap: 0.5, ml: -1 } }>
          { daysOfWeek.map(day => {
            const lowerCaseDay = day.toLowerCase() as DayOfWeek;
            return <ToggleButton
              key={ day }
              value={ lowerCaseDay }
              aria-label={ day }
              selected={ selectedDays[lowerCaseDay] }
              disabled={ isUpdating }
              onChange={ () => toggleSelectedDay(lowerCaseDay) }
              sx={ dayChipSx }>{ day.slice(0, 3) }</ToggleButton>;
          }) }
        </Box>
      </AccordionDetails>
    </Accordion>
  );
}
